import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { DEFAULT_MIN_PAYOUT_SATS, resolveMinPayoutSats } from './coinbase-distribution';

/**
 * Daily ledger maintenance for PPLNS balances.
 *
 * Runs two independent sweeps:
 *
 *   1. PPLNS pair-sweep (signed balances) —
 *      Built for the credit/debit ledger introduced with the
 *      RenamePplnsPendingToBalance migration. Finds dormant rows with
 *      balanceSats != 0 (either sign) whose lastAcceptedShareAt is
 *      older than ABANDONED_BALANCE_DAYS. Pairs the largest abandoned
 *      credit against the largest abandoned debit and cancels
 *      matching amounts on both sides. Unpaired remainders stay in
 *      the ledger until a counterparty becomes available (either a
 *      matching dormant row or the miner's own return to mining).
 *
 *      This preserves sum(balances) = 0 strictly — no silent drift
 *      toward fee or other active miners. The physical sats that
 *      back an abandoned credit already live on-chain in a past
 *      coinbase output; the pool is non-custodial and cannot
 *      redistribute them, so pair-cancellation is the one ledger
 *      action that is materially neutral for everyone else.
 *
 *   2. Group-Solo dust sweep (unsigned, legacy) —
 *      Group-Solo balances stay on the simpler "positive pending"
 *      model because the feature intentionally forbids trim/sub-dust
 *      accumulation (groups are capped small enough that every
 *      member's share clears dust every block). Finds dormant rows
 *      with 0 < pendingSats < DUST and lastAcceptedShareAt past the
 *      cutoff, writes an audit row and deletes the balance.
 *
 * Why different: group-solo's ledger can only ever go positive
 * (pendingSats is the old non-negative pending field; no bonus-
 * redistribution happens for group rounds), so there is no
 * counterparty to pair with. A single-sided dust absorption is
 * semantically correct there.
 *
 * Env:
 *   DUST_SWEEP_ENABLED        default 'true'   — set 'false' to disable
 *   ABANDONED_BALANCE_DAYS    default '90'     — PPLNS sweep cutoff (3 months)
 *   DUST_SWEEP_DORMANT_DAYS   default '30'     — legacy group-solo cutoff
 *
 * ABANDONED_BALANCE_DAYS defaults to 90 (3 months): long enough that
 * a short-term Bitaxe operator who briefly tested the pool doesn't
 * see their pending credit evaporate, but short enough that the
 * ledger stays clean and dust rows don't pile up indefinitely. The
 * group-solo dust cutoff keeps the original 30-day default because
 * those balances are all < 546 sat remnants with no counterparty to
 * wait for.
 *
 * blockHeight for audit rows: encoded as `-Math.floor(Date.now() / 1000)`
 * (negative Unix seconds). Two reasons:
 *   1. Audit rows aren't associated with any real block — a negative
 *      value cannot be confused with a real height.
 *   2. The unique index on (blockHeight, address) would otherwise
 *      block a second sweep of the same address once the row has
 *      been recreated by fresh mining activity.
 *
 * NULL-handling: lastAcceptedShareAt IS NULL is treated as "no signal"
 * NOT as "infinitely stale". Pre-migration balance rows have NULL;
 * they get a timestamp on the miner's next accepted share and only
 * become sweep candidates after real inactivity.
 */
@Injectable()
export class DustSweepService implements OnModuleInit {

    private enabled = true;
    private dormantDays = 30;
    private abandonedDays = 90;
    /**
     * Group-solo sweep threshold. Reads `PPLNS_MIN_PAYOUT_SATS` so the
     * sweep absorbs anything below the operational payout floor — not
     * just sub-protocol-dust. Clamped to ≥ DUST_LIMIT_SATS.
     */
    private minPayoutSats = DEFAULT_MIN_PAYOUT_SATS;

    /**
     * Last blockHeight returned by `sweepBlockHeight()`. Kept in memory
     * so sub-second re-triggers (manual `service.sweep()` calls from a
     * test or admin endpoint) stay strictly monotonic and don't collide
     * with the previous run on the `(blockHeight, address)` unique
     * index.
     */
    private lastSweepBlockHeight: number | null = null;

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
        const dormantRaw = parseInt(this.configService.get<string>('DUST_SWEEP_DORMANT_DAYS') ?? '30', 10);
        this.dormantDays = Number.isFinite(dormantRaw) && dormantRaw > 0 ? dormantRaw : 30;
        const abandonedRaw = parseInt(this.configService.get<string>('ABANDONED_BALANCE_DAYS') ?? '90', 10);
        this.abandonedDays = Number.isFinite(abandonedRaw) && abandonedRaw > 0 ? abandonedRaw : 90;
        this.minPayoutSats = resolveMinPayoutSats(this.configService.get<string>('PPLNS_MIN_PAYOUT_SATS'));

        console.log(
            `[DustSweep] enabled=${this.enabled}, dormantDays=${this.dormantDays}, `
            + `abandonedDays=${this.abandonedDays}, groupMinPayout=${this.minPayoutSats}`,
        );
    }

    /** PPLNS pair-sweep inactivity threshold in days (read-only for API / UI). */
    getAbandonedDays(): number {
        return this.abandonedDays;
    }

    /** Group-Solo legacy dust-sweep inactivity threshold in days. */
    getDormantDays(): number {
        return this.dormantDays;
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
     * Public for tests and manual-trigger admin endpoints.
     *
     * Returns a summary of what each sweep absorbed:
     *   - pplnsPaired   — rows zeroed via credit↔debit pair match
     *   - pplnsSatsPaired — abs-sum of paired amount (one side, not double)
     *   - groupSwept    — group-solo legacy dust rows deleted
     */
    async sweep(): Promise<{
        pplnsPaired: number;
        pplnsSatsPaired: number;
        groupSwept: number;
    }> {
        const abandonedCutoffMs = Date.now() - this.abandonedDays * 24 * 60 * 60 * 1000;
        const dustCutoffMs = Date.now() - this.dormantDays * 24 * 60 * 60 * 1000;

        const pplnsResult = await this.sweepPplnsPairs(abandonedCutoffMs);
        const groupSwept = await this.sweepGroupDust(dustCutoffMs);

        if (pplnsResult.pairsClosed > 0 || groupSwept > 0) {
            console.log(
                `[DustSweep] PPLNS paired ${pplnsResult.pairsClosed} rows `
                + `(${pplnsResult.satsPaired} sats), group-solo swept ${groupSwept} dust rows `
                + `(abandoned<${new Date(abandonedCutoffMs).toISOString()}, dust<${new Date(dustCutoffMs).toISOString()})`,
            );
        }

        return {
            pplnsPaired: pplnsResult.pairsClosed,
            pplnsSatsPaired: pplnsResult.satsPaired,
            groupSwept,
        };
    }

    /**
     * Generate a blockHeight placeholder for audit rows that doesn't
     * collide with prior sweep rows for the same address. Negative
     * Unix seconds, kept strictly monotonic across calls so a
     * sub-second re-trigger (manual `service.sweep()` from a test or
     * admin endpoint) doesn't reuse the previous call's value and
     * break the `(blockHeight, address)` unique index.
     */
    private sweepBlockHeight(): number {
        const now = -Math.floor(Date.now() / 1000);
        if (this.lastSweepBlockHeight !== null && now >= this.lastSweepBlockHeight) {
            // Sub-second re-trigger: the wall-clock value would match
            // or exceed the last one (values are negative, "smaller"
            // means later). Step back by one to stay unique.
            this.lastSweepBlockHeight = this.lastSweepBlockHeight - 1;
        } else {
            this.lastSweepBlockHeight = now;
        }
        return this.lastSweepBlockHeight;
    }

    /**
     * Pair-cancel dormant PPLNS credits and debits.
     *
     * Algorithm:
     *   1. Load all rows whose lastAcceptedShareAt is older than the
     *      abandoned cutoff and balanceSats != 0.
     *   2. Split by sign. Sort credits by balance desc, debits by
     *      |balance| desc.
     *   3. Walk both lists, greedy-matching largest against largest.
     *      For each pair, cancel min(credit, |debit|) on both sides.
     *      Whichever side reaches zero is fully removed from the
     *      ledger; the other side's row stays with its reduced
     *      balance and original lastAcceptedShareAt timestamp (so
     *      it remains a sweep candidate next run).
     *   4. Each balance change is recorded as a dust-sweep audit row
     *      in pplns_payout_history (paidSats = |amount cancelled|).
     *      Matching rows share a blockHeight so an operator can see
     *      which credit paired with which debit.
     *
     * Sum(balances) across the whole ledger is preserved strictly:
     * a pair cancels +X on the credit side and -X on the debit side,
     * delta = 0.
     */
    private async sweepPplnsPairs(cutoffMs: number): Promise<{ pairsClosed: number; satsPaired: number }> {
        const candidates = await this.pplnsBalanceRepo
            .createQueryBuilder('b')
            .where('b."balanceSats" != 0')
            .andWhere('b."lastAcceptedShareAt" IS NOT NULL')
            .andWhere('b."lastAcceptedShareAt" < :cutoffMs', { cutoffMs })
            .getMany();

        if (candidates.length === 0) return { pairsClosed: 0, satsPaired: 0 };

        const credits = candidates
            .filter(r => r.balanceSats > 0)
            .sort((a, b) => b.balanceSats - a.balanceSats);
        const debits = candidates
            .filter(r => r.balanceSats < 0)
            .sort((a, b) => a.balanceSats - b.balanceSats);   // most-negative first

        if (credits.length === 0 || debits.length === 0) {
            console.log(
                `[DustSweep] PPLNS: ${candidates.length} abandoned rows but no counterparty `
                + `to pair (${credits.length} credits / ${debits.length} debits) — leaving in ledger`,
            );
            return { pairsClosed: 0, satsPaired: 0 };
        }

        let pairsClosed = 0;
        let satsPaired = 0;

        let i = 0, j = 0;
        while (i < credits.length && j < debits.length) {
            const credit = credits[i];
            const debit = debits[j];

            const amount = Math.min(credit.balanceSats, -debit.balanceSats);
            if (amount <= 0) break;   // sanity

            // Compute post-cancel values WITHOUT mutating the in-memory
            // rows yet. If the TX rolls back (DB write fails, FK glitch,
            // connection drop), in-memory must stay at its pre-TX value
            // so the outer loop's advance-check reads reality, not a
            // speculative state that was never persisted.
            const newCreditBalance = credit.balanceSats - amount;
            const newDebitBalance = debit.balanceSats + amount;

            // Unique blockHeight per pair so the (blockHeight, address)
            // index doesn't reject the second iteration when a single
            // debit row gets matched against multiple smaller credits
            // across pairs (or vice-versa). Both rows of THIS pair still
            // share the same value so an operator can group them.
            const blockHeight = this.sweepBlockHeight();

            try {
                await this.pplnsHistoryRepo.manager.transaction(async (em) => {
                    const history = em.getRepository(PplnsPayoutHistoryEntity);
                    const balance = em.getRepository(PplnsBalanceEntity);

                    await history.save([
                        history.create({
                            blockHeight,
                            address: credit.address,
                            paidSats: amount,
                            percent: 0,
                            rowType: 'dust-sweep',
                        }),
                        history.create({
                            blockHeight,
                            address: debit.address,
                            paidSats: amount,
                            percent: 0,
                            rowType: 'dust-sweep',
                        }),
                    ]);

                    if (newCreditBalance === 0) {
                        await balance.delete({ address: credit.address });
                    } else {
                        await balance.update({ address: credit.address }, { balanceSats: newCreditBalance });
                    }
                    if (newDebitBalance === 0) {
                        await balance.delete({ address: debit.address });
                    } else {
                        await balance.update({ address: debit.address }, { balanceSats: newDebitBalance });
                    }
                });

                // TX committed — reflect the cancellation in memory now
                // so the outer loop's pointer-advance check sees the
                // same state the DB has.
                credit.balanceSats = newCreditBalance;
                debit.balanceSats = newDebitBalance;

                pairsClosed += 2;
                satsPaired += amount;
                console.log(
                    `[DustSweep] paired ${credit.address} credit <-> ${debit.address} debit `
                    + `(${amount} sats each side cancelled)`,
                );
            } catch (err) {
                console.warn(
                    `[DustSweep] pair ${credit.address}/${debit.address} failed:`,
                    (err as Error).message,
                );
                // TX rolled back; both in-memory balances untouched and
                // DB rows unchanged. Force progress past the failing
                // pair — next sweep run retries against the identical
                // DB state. Advance both pointers unconditionally to
                // avoid spinning: we don't know which side caused the
                // failure, so skip the pair entirely and let the next
                // run (24 h later) retry at pair A/X against fresh DB
                // context. Remaining non-failing rows in credits[i+1..]
                // and debits[j+1..] still pair normally in this run.
                i++;
                j++;
                continue;
            }

            if (credit.balanceSats === 0) i++;
            if (debit.balanceSats === 0) j++;
        }

        const unpairedCredits = credits.length - i;
        const unpairedDebits = debits.length - j;
        if (unpairedCredits > 0 || unpairedDebits > 0) {
            console.log(
                `[DustSweep] PPLNS: ${unpairedCredits} abandoned credits + `
                + `${unpairedDebits} abandoned debits unpaired (waiting for counterparty)`,
            );
        }

        return { pairsClosed, satsPaired };
    }

    /**
     * Legacy group-solo dust absorption. Group balances are still on
     * the unsigned-pending model (no trim / no sub-dust by design),
     * so the single-sided sweep is correct: positive rows < dust that
     * haven't mined in dormantDays are deleted with an audit row.
     */
    private async sweepGroupDust(cutoffMs: number): Promise<number> {
        const candidates = await this.groupBalanceRepo
            .createQueryBuilder('b')
            .where('b."pendingSats" > 0')
            // Sweep anything below the operational payout floor — sub-
            // dust outputs that would never become economically spendable
            // anyway. Tracks `PPLNS_MIN_PAYOUT_SATS`, not just the raw
            // 546 protocol-policy value.
            .andWhere('b."pendingSats" < :minPayout', { minPayout: this.minPayoutSats })
            .andWhere('b."lastAcceptedShareAt" IS NOT NULL')
            .andWhere('b."lastAcceptedShareAt" < :cutoffMs', { cutoffMs })
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
