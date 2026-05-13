import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';

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
     * In-memory buffer of latest touch timestamp per address. PPLNS shares
     * fire markTouch (synchronous, no-await) instead of a PG UPDATE
     * per share. The only consumer of lastAcceptedShareAt is the nightly
     * abandoned-balance sweep, which tolerates the 60 s flush lag trivially.
     */
    private pendingTouches = new Map<string, Date>();
    private isFlushingTouches = false;

    constructor(
        @InjectRepository(PplnsBalanceEntity)
        private readonly repo: Repository<PplnsBalanceEntity>,
    ) {}

    async onModuleDestroy(): Promise<void> {
        await this.flushPendingTouches();
    }

    async getBalanceSats(address: string): Promise<number> {
        const entity = await this.repo.findOneBy({ address });
        return entity?.balanceSats ?? 0;
    }

    async getBalance(address: string): Promise<PplnsBalanceEntity | null> {
        return this.repo.findOneBy({ address });
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
     * the in-memory buffer. Synchronous, non-throwing. Coalesces multiple
     * share-marks per flush window into one PG UPDATE.
     */
    markTouch(address: string, when: Date = new Date()): void {
        if (!address) return;
        this.pendingTouches.set(address, when);
    }

    /**
     * Bulk-flush buffered touch timestamps to PG. Postgres uses
     * `UPDATE … FROM unnest(...)`; sqlite (dev/test) falls back to per-row.
     * Rows that don't exist yet are left alone — the abandoned-balance
     * sweep has nothing to act on for a miner without a balance row.
     */
    @Interval(60_000)
    async flushPendingTouches(): Promise<void> {
        if (this.isFlushingTouches || this.pendingTouches.size === 0) return;
        this.isFlushingTouches = true;

        const snapshot = this.pendingTouches;
        this.pendingTouches = new Map();

        try {
            const dbType = this.repo.manager.connection.options.type;
            if (dbType === 'postgres') {
                const addresses: string[] = [];
                const stamps: Date[] = [];
                for (const [addr, ts] of snapshot) {
                    addresses.push(addr);
                    stamps.push(ts);
                }
                await this.repo.query(
                    `UPDATE pplns_balance AS t
                     SET "lastAcceptedShareAt" = u."lastAcceptedShareAt"
                     FROM (
                       SELECT unnest($1::text[]) AS address,
                              unnest($2::timestamptz[]) AS "lastAcceptedShareAt"
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
            // Re-buffer on failure so the next flush retries.
            for (const [addr, ts] of snapshot) {
                if (!this.pendingTouches.has(addr)) {
                    this.pendingTouches.set(addr, ts);
                }
            }
            console.warn('[PplnsBalance] flushPendingTouches failed:', (error as Error).message);
        } finally {
            this.isFlushingTouches = false;
        }
    }

    async getAll(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find();
    }
}
