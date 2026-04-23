import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository, And } from 'typeorm';

import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { DUST_LIMIT_SATS } from './coinbase-distribution';

/**
 * Daily sweep of dormant sub-dust pending balances.
 *
 * Why: a user who briefly tested PPLNS or got added to a group and left
 * shortly after may have a few hundred sats of pending that will never
 * reach the dust limit (no further mining). Those rows linger forever in
 * pplns_balance / pplns_group_balance, polluting queries and moral
 * expectation ("I have 31 sats!" that will never get paid).
 *
 * What: once per day, find rows with
 *     pendingSats > 0 AND pendingSats < DUST_LIMIT_SATS
 *     AND lastAcceptedShareAt < NOW() - DUST_SWEEP_DORMANT_DAYS
 * Write a dedicated audit row (rowType='dust-sweep') so the history
 * remains explainable, then delete the balance row. No on-chain action —
 * the sats were never actually minted; the "pending" was purely a pool-
 * side ledger promise.
 *
 * blockHeight for audit rows: encoded as `-Math.floor(Date.now() / 1000)`
 * (negative Unix seconds). Two reasons:
 *   1. Audit rows aren't associated with any real block — a negative
 *      value cannot be confused with a real height.
 *   2. The unique index on (blockHeight, address) added in
 *      1776800000000-AddPayoutHistoryUniqueConstraints would otherwise
 *      block a second sweep of the same address: balance row is deleted
 *      after sweep, miner resumes mining, accumulates dust again, goes
 *      dormant → next sweep tries to insert (blockHeight=0, address) a
 *      second time → 23505. Using the current epoch makes the pair unique
 *      across sweep runs (second-granularity is enough given the 24h
 *      cadence).
 *
 * Env:
 *   DUST_SWEEP_ENABLED       default 'true'   — set 'false' to disable
 *   DUST_SWEEP_DORMANT_DAYS  default '30'     — inactivity threshold
 *
 * NULL-handling: lastAcceptedShareAt IS NULL is treated as "no signal",
 * NOT as "infinitely stale". Pre-migration balance rows have NULL; they
 * get a timestamp on the miner's next accepted share and only become
 * sweep candidates after real inactivity. This is deliberately
 * conservative — we'd rather let a few legacy rows sit than wrongly
 * sweep an active miner.
 */
@Injectable()
export class DustSweepService implements OnModuleInit {

    private enabled = true;
    private dormantDays = 30;

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(PplnsBalanceEntity)
        private readonly pplnsBalanceRepo: Repository<PplnsBalanceEntity>,
        @InjectRepository(PplnsPayoutHistoryEntity)
        private readonly pplnsHistoryRepo: Repository<PplnsPayoutHistoryEntity>,
        @InjectRepository(PplnsGroupBalanceEntity)
        private readonly groupBalanceRepo: Repository<PplnsGroupBalanceEntity>,
        @InjectRepository(PplnsGroupBlockHistoryEntity)
        private readonly groupHistoryRepo: Repository<PplnsGroupBlockHistoryEntity>,
    ) {}

    onModuleInit(): void {
        const enabledRaw = (this.configService.get<string>('DUST_SWEEP_ENABLED') ?? 'true').toLowerCase();
        this.enabled = enabledRaw !== 'false' && enabledRaw !== '0';
        const daysRaw = parseInt(this.configService.get<string>('DUST_SWEEP_DORMANT_DAYS') ?? '30', 10);
        this.dormantDays = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;

        console.log(`[DustSweep] enabled=${this.enabled}, dormantDays=${this.dormantDays}`);
    }

    /** 03:00 daily — low-traffic window, same cadence as other daily crons. */
    @Cron('0 0 3 * * *')
    async sweepDaily(): Promise<void> {
        if (!this.enabled) return;
        try {
            await this.sweep();
        } catch (err) {
            console.error('[DustSweep] failed:', err);
        }
    }

    /**
     * Public for tests and manual-trigger admin endpoints. Runs both
     * pools (PPLNS main + group-solo) in sequence; each is independent
     * so a failure in one doesn't block the other.
     */
    async sweep(): Promise<{ pplnsSwept: number; groupSwept: number; }> {
        const cutoff = new Date(Date.now() - this.dormantDays * 24 * 60 * 60 * 1000);
        const pplnsSwept = await this.sweepPplns(cutoff);
        const groupSwept = await this.sweepGroup(cutoff);
        if (pplnsSwept > 0 || groupSwept > 0) {
            console.log(`[DustSweep] absorbed ${pplnsSwept} PPLNS and ${groupSwept} group-solo dust rows (cutoff=${cutoff.toISOString()})`);
        }
        return { pplnsSwept, groupSwept };
    }

    /**
     * Generate a blockHeight placeholder for audit rows that doesn't
     * collide with prior dust-sweep rows for the same address. Negative
     * Unix seconds — easy to recognise, fits in Postgres int, and unique
     * across sweep runs at second granularity.
     */
    private sweepBlockHeight(): number {
        return -Math.floor(Date.now() / 1000);
    }

    private async sweepPplns(cutoff: Date): Promise<number> {
        const candidates = await this.pplnsBalanceRepo
            .createQueryBuilder('b')
            .where('b."pendingSats" > 0')
            .andWhere('b."pendingSats" < :dust', { dust: DUST_LIMIT_SATS })
            .andWhere('b."lastAcceptedShareAt" IS NOT NULL')
            .andWhere('b."lastAcceptedShareAt" < :cutoff', { cutoff })
            .getMany();

        let swept = 0;
        for (const row of candidates) {
            try {
                await this.pplnsHistoryRepo.manager.transaction(async (em) => {
                    const history = em.getRepository(PplnsPayoutHistoryEntity);
                    const balance = em.getRepository(PplnsBalanceEntity);
                    await history.save(history.create({
                        blockHeight: this.sweepBlockHeight(),
                        address: row.address,
                        paidSats: row.pendingSats,
                        percent: 0,
                        inCoinbase: false,
                        rowType: 'dust-sweep',
                    }));
                    await balance.delete({ address: row.address });
                });
                swept++;
            } catch (err) {
                console.warn(`[DustSweep] pplns row ${row.address} failed:`, (err as Error).message);
            }
        }
        return swept;
    }

    private async sweepGroup(cutoff: Date): Promise<number> {
        const candidates = await this.groupBalanceRepo
            .createQueryBuilder('b')
            .where('b."pendingSats" > 0')
            .andWhere('b."pendingSats" < :dust', { dust: DUST_LIMIT_SATS })
            .andWhere('b."lastAcceptedShareAt" IS NOT NULL')
            .andWhere('b."lastAcceptedShareAt" < :cutoff', { cutoff })
            .getMany();

        let swept = 0;
        for (const row of candidates) {
            try {
                await this.groupHistoryRepo.manager.transaction(async (em) => {
                    const history = em.getRepository(PplnsGroupBlockHistoryEntity);
                    const balance = em.getRepository(PplnsGroupBalanceEntity);
                    await history.save(history.create({
                        groupId: row.groupId,
                        blockHeight: this.sweepBlockHeight(),
                        address: row.address,
                        paidSats: row.pendingSats,
                        percent: 0,
                        sharesInRound: 0,
                        totalSharesInRound: 0,
                        inCoinbase: false,
                        rowType: 'dust-sweep',
                    }));
                    await balance.delete({ address: row.address, groupId: row.groupId });
                });
                swept++;
            } catch (err) {
                console.warn(`[DustSweep] group-solo row ${row.address}/${row.groupId} failed:`, (err as Error).message);
            }
        }
        return swept;
    }
}
