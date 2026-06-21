// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';
import { SwapBuffer } from '../../utils/buffers';

/**
 * Thin data-access layer around the PPLNS credit/debit ledger.
 *
 * The only supported write path is `onBlockFound`'s batch write:
 * `buildCoinbaseDistribution` returns a `balanceAfter` map of absolute
 * post-block balances, and the block-found transaction UPSERTs those
 * values directly (via the repository). There is no incremental
 * `addBalance(delta)` or `markPaid(sats)` helper because both would
 * race with the atomic absolute-write pattern used on the hot path —
 * two independent paths writing the same row is exactly the kind of
 * ledger drift the signed-ledger refactor was designed to rule out.
 *
 * The getters expose either a single balance or all non-zero ledger
 * rows — the latter is what `buildCoinbaseDistribution` consumes to
 * figure out who has open claims (either direction) at distribution
 * time.
 */
@Injectable()
export class PplnsBalanceService implements OnModuleDestroy {

    /**
     * In-memory buffer of latest touch timestamp per address (epoch ms).
     * PPLNS shares fire markTouch (synchronous, no-await) instead of a PG
     * UPDATE per share. The only consumer of lastAcceptedShareAt is the
     * nightly abandoned-balance sweep, which tolerates the 60 s flush
     * lag trivially.
     */
    private readonly touches = new SwapBuffer<string, number>();
    private isFlushingTouches = false;

    constructor(
        @InjectRepository(PplnsBalanceEntity)
        private readonly repo: Repository<PplnsBalanceEntity>,
    ) {}

    async onModuleDestroy(): Promise<void> {
        await this.flushPendingTouches();
    }

    async getBalanceSats(address: string): Promise<number> {
        if (this.repo.manager.connection.options.type === 'postgres') {
            // Raw SELECT — bypasses entity hydration (RawSqlResultsToEntityTransformer).
            // UI endpoint hot path; called per dashboard poll for every active miner.
            const rows: Array<{ balanceSats: string }> = await this.repo.query(
                `SELECT "balanceSats" FROM pplns_balance WHERE address = $1 LIMIT 1`,
                [address],
            );
            return rows[0] ? Number(rows[0].balanceSats) : 0;
        }
        const entity = await this.repo.findOneBy({ address });
        return entity?.balanceSats ?? 0;
    }

    async getBalance(address: string): Promise<PplnsBalanceEntity | null> {
        return this.repo.findOneBy({ address });
    }

    /**
     * Hot-path lookup used by `getAddressStatus` for the per-miner UI poll.
     * Returns just the two scalar balance fields — no Date hydration, no
     * entity construction. Sqlite path keeps `findOneBy` for dev/test parity.
     */
    async getBalanceLight(address: string): Promise<{ balanceSats: number; totalPaidSats: number } | null> {
        if (this.repo.manager.connection.options.type === 'postgres') {
            const rows: Array<{ balanceSats: string; totalPaidSats: string }> = await this.repo.query(
                `SELECT "balanceSats", "totalPaidSats" FROM pplns_balance WHERE address = $1 LIMIT 1`,
                [address],
            );
            if (!rows[0]) return null;
            return {
                balanceSats: Number(rows[0].balanceSats),
                totalPaidSats: Number(rows[0].totalPaidSats),
            };
        }
        const entity = await this.repo.findOneBy({ address });
        return entity ? { balanceSats: entity.balanceSats, totalPaidSats: entity.totalPaidSats } : null;
    }

    /**
     * All rows with a non-zero balance (credit or debit). Consumed by
     * `buildCoinbaseDistribution` so it can factor open claims in
     * either direction into the next block's distribution.
     */
    async getAllWithBalance(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find({ where: { balanceSats: Not(0) } });
    }

    /**
     * Record the most recent accepted-share timestamp for an address in
     * the in-memory buffer (epoch ms). Synchronous, non-throwing.
     * Coalesces multiple share-marks per flush window into one PG UPDATE.
     */
    markTouch(address: string, when: number = Date.now()): void {
        if (!address) return;
        this.touches.set(address, when);
    }

    /**
     * Bulk-flush buffered touch timestamps to PG. Postgres uses
     * `UPDATE … FROM unnest(...)`; sqlite (dev/test) falls back to per-row.
     * Rows that don't exist yet are left alone — the abandoned-balance
     * sweep has nothing to act on for a miner without a balance row.
     */
    @Interval(60_000)
    async flushPendingTouches(): Promise<void> {
        if (this.isFlushingTouches || this.touches.size === 0) return;
        this.isFlushingTouches = true;

        const snapshot = this.touches.drain();
        try {
            const dbType = this.repo.manager.connection.options.type;
            if (dbType === 'postgres') {
                const addresses: string[] = [];
                const stamps: number[] = [];
                for (const [addr, ts] of snapshot) {
                    addresses.push(addr);
                    stamps.push(ts);
                }
                await this.repo.query(
                    `UPDATE pplns_balance AS t
                     SET "lastAcceptedShareAt" = u."lastAcceptedShareAt"
                     FROM (
                       SELECT unnest($1::text[]) AS address,
                              unnest($2::bigint[]) AS "lastAcceptedShareAt"
                     ) AS u
                     WHERE t.address = u.address`,
                    [addresses, stamps],
                );
            } else {
                for (const [address, lastAcceptedShareAt] of snapshot) {
                    await this.repo.update({ address }, { lastAcceptedShareAt });
                }
            }
        } catch (error) {
            // Re-buffer on failure so the next flush retries. Default policy
            // (existing-wins-if-newer) keeps any newer touch the hot path
            // recorded during the failed flush.
            this.touches.rebuffer(snapshot);
            console.warn('[PplnsBalance] flushPendingTouches failed:', (error as Error).message);
        } finally {
            this.isFlushingTouches = false;
        }
    }

    async getAll(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find();
    }
}
