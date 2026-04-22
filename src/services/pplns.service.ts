import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { PplnsBalanceService } from '../ORM/pplns-balance/pplns-balance.service';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import {
    buildCoinbaseDistribution,
    DUST_LIMIT_SATS,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
    COINBASE_BASE_WEIGHT,
    COINBASE_OUTPUT_WEIGHT,
    COINBASE_WITNESS_COMMITMENT_WEIGHT,
} from './coinbase-distribution';

/**
 * PPLNS (Pay Per Last N Shares) engine.
 *
 * Tracks shares in a Redis sorted set and computes coinbase payout
 * distributions.  Window size = 4 * network_difficulty (diff1-equivalent).
 *
 * Only active when PPLNS_PORT is configured.
 */

const PPLNS_WINDOW_FACTOR = 4;
const REDIS_KEY_SHARES = 'pplns:shares';
const REDIS_KEY_COUNTER = 'pplns:counter';
const REDIS_KEY_WINDOW_TOTAL = 'pplns:window:total';
// Coinbase snapshot — JSON-encoded distribution that was actually used to
// build the latest coinbase. Persisted in Redis (not an in-memory Map) so
// a pool restart between getPayoutDistribution and onBlockFound doesn't
// lose it and force onBlockFoundFromWindow (whose distribution can differ
// from what's already on-chain).
const REDIS_KEY_SNAPSHOT = 'pplns:snapshot';
const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block-find + restart window.

// DUST_LIMIT_SATS + coinbase weight constants live in ./coinbase-distribution.ts
// (the shared pure module used by both PPLNS and Group-Solo). Single source of
// truth so fee dust-gate / weight-budget-trim / pending-out-of-miner-cut all
// stay in sync across payout modes.

export interface PplnsPayoutEntry {
    address: string;
    percent: number;
}

@Injectable()
export class PplnsService implements OnModuleInit, OnModuleDestroy {
    private redis: any = null;
    private enabled = false;
    private feeAddress: string;
    private feePercent: number;
    private networkDifficulty = 0;
    private jobSubscription: Subscription | null = null;
    private readonly coinbaseWeightBudget: number;

    // Distribution cache — avoids re-reading entire Redis sorted set on every job
    private cachedDistribution: PplnsPayoutEntry[] | null = null;
    private cachedDistributionReward = 0;
    private cachedDistributionAt = 0;
    private static readonly DISTRIBUTION_CACHE_TTL_MS = 30_000; // 30 seconds max

    // Coinbase snapshot is persisted via Redis (see REDIS_KEY_SNAPSHOT /
    // SNAPSHOT_TTL_SECONDS). The helpers `writeSnapshot` / `readSnapshot` /
    // `deleteSnapshot` wrap the (de)serialization so no in-memory state
    // needs to survive a pool restart for onBlockFound to book payouts
    // against the exact distribution that went on-chain.

    // Block-found lock — prevents concurrent onBlockFound calls from double-processing
    private blockFoundInProgress = false;

    // NOTE: The PPLNS share window intentionally does NOT reset after a block is found.
    // This is correct PPLNS behavior — shares within the window contribute to multiple
    // blocks. A reset would be PROP (proportional) payout, not PPLNS. The sliding window
    // protects against pool-hopping attacks.

    constructor(
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly balanceService: PplnsBalanceService,
        @InjectRepository(PplnsPayoutHistoryEntity)
        private readonly payoutHistoryRepo: Repository<PplnsPayoutHistoryEntity>,
        private readonly stratumV1JobsService: StratumV1JobsService,
    ) {
        this.feeAddress = this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(this.configService.get('PPLNS_FEE_PERCENT') ?? '2');
        this.coinbaseWeightBudget = parseInt(this.configService.get('PPLNS_COINBASE_WEIGHT_BUDGET') ?? DEFAULT_COINBASE_WEIGHT_BUDGET.toString(), 10) || DEFAULT_COINBASE_WEIGHT_BUDGET;
        this.enabled = !!this.configService.get('PPLNS_PORT');
    }

    async onModuleInit(): Promise<void> {
        if (!this.enabled) return;

        try {
            const store: any = this.cacheManager.store;
            if (store?.client) {
                this.redis = store.client;
                console.log('[PPLNS] Service initialized with Redis');
            } else {
                console.error('[PPLNS] Redis not available — PPLNS will not function!');
            }
        } catch (error) {
            console.error('[PPLNS] Failed to access Redis client:', error);
        }

        // Subscribe to new block templates to keep network difficulty in sync
        this.jobSubscription = this.stratumV1JobsService.newMiningJob$.subscribe((jobTemplate) => {
            if (jobTemplate?.blockData?.networkDifficulty) {
                this.setNetworkDifficulty(jobTemplate.blockData.networkDifficulty);
            }
        });
        console.log('[PPLNS] Subscribed to block template updates for network difficulty');
    }

    onModuleDestroy(): void {
        this.jobSubscription?.unsubscribe();
    }

    isEnabled(): boolean {
        return this.enabled && !!this.redis;
    }

    /**
     * Pool fee config exposed to the UI so the landing pages can show current
     * fees dynamically without hard-coding them. Same config is reused by the
     * group-solo path, so one endpoint covers both modes.
     */
    getFeeConfig(): { feePercent: number; feeAddress: string; coinbaseWeightBudget: number } {
        return {
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
        };
    }

    /**
     * Update network difficulty (called when new block template arrives).
     */
    setNetworkDifficulty(difficulty: number): void {
        if (Number.isFinite(difficulty) && difficulty > 0) {
            this.networkDifficulty = difficulty;
        }
    }

    /**
     * Get the current PPLNS window size in diff1-equivalent shares.
     */
    getWindowSize(): number {
        return PPLNS_WINDOW_FACTOR * this.networkDifficulty;
    }

    /**
     * Max miner outputs that fit in the coinbase weight budget. Mirrors
     * the formula in `buildCoinbaseDistribution`: base + witness-commitment
     * are always present; fee output is present only when `feeAddress` is
     * configured; the rest of the budget splits into miner outputs at
     * `COINBASE_OUTPUT_WEIGHT` each.
     */
    getMaxCoinbaseOutputs(): number {
        const feeOutputCount = this.feeAddress ? 1 : 0;
        return Math.floor(
            (this.coinbaseWeightBudget
                - COINBASE_BASE_WEIGHT
                - COINBASE_WITNESS_COMMITMENT_WEIGHT
                - feeOutputCount * COINBASE_OUTPUT_WEIGHT)
            / COINBASE_OUTPUT_WEIGHT,
        );
    }

    // ── Share Recording ──────────────────────────────────────────

    /**
     * Record an accepted share from a PPLNS miner.
     */
    async recordShare(address: string, difficulty: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        const counter = await this.redis.incr(REDIS_KEY_COUNTER);
        const entry = `${address}:${difficulty}:${Date.now()}`;
        await this.redis.zAdd(REDIS_KEY_SHARES, { score: counter, value: entry });
        await this.redis.incrByFloat(REDIS_KEY_WINDOW_TOTAL, difficulty);

        // Invalidate cached distribution — share weights changed
        this.cachedDistribution = null;

        await this.trimWindow();
    }

    private trimCounter = 0;

    /**
     * Trim oldest shares to keep window within N = 4 * networkDifficulty.
     */
    private async trimWindow(): Promise<void> {
        const windowSize = this.getWindowSize();
        if (windowSize <= 0) return;

        const totalStr = await this.redis.get(REDIS_KEY_WINDOW_TOTAL);
        let total = parseFloat(totalStr) || 0;

        // Trim in batches of 100 for efficiency
        while (total > windowSize) {
            const oldest = await this.redis.zRange(REDIS_KEY_SHARES, 0, 99);
            if (!oldest || oldest.length === 0) break;

            let removedDiff = 0;
            for (const entry of oldest) {
                const parts = entry.split(':');
                removedDiff += parseFloat(parts[1]) || 0;
            }

            await this.redis.zRemRangeByRank(REDIS_KEY_SHARES, 0, oldest.length - 1);
            total -= removedDiff;
        }

        this.trimCounter++;

        // Every 1000 trims, recalculate total from sorted set to fix float drift
        if (this.trimCounter % 1000 === 0) {
            total = await this.recalculateWindowTotal();
        }

        await this.redis.set(REDIS_KEY_WINDOW_TOTAL, total.toString());
    }

    /**
     * Recalculate window total from all entries in the sorted set.
     * Fixes accumulated floating-point drift.
     */
    private async recalculateWindowTotal(): Promise<number> {
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        let total = 0;
        for (const entry of (entries ?? [])) {
            total += parseFloat(entry.split(':')[1]) || 0;
        }
        return total;
    }

    // ── Payout Distribution ──────────────────────────────────────

    /**
     * Calculate the current PPLNS payout distribution for coinbase construction.
     * Returns an array of {address, percent} suitable for MiningJob.
     *
     * @param blockRewardSats - Total block reward in satoshis
     */
    async getPayoutDistribution(blockRewardSats: number): Promise<PplnsPayoutEntry[]> {
        if (!this.redis || !this.enabled) {
            return this.fallbackDistribution();
        }

        // Return cached distribution if still valid (same reward, not expired, not invalidated)
        if (
            this.cachedDistribution &&
            this.cachedDistributionReward === blockRewardSats &&
            Date.now() - this.cachedDistributionAt < PplnsService.DISTRIBUTION_CACHE_TTL_MS
        ) {
            return this.cachedDistribution;
        }

        // 1. Read all shares from window
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (!entries || entries.length === 0) {
            return this.fallbackDistribution();
        }

        // 2. Sum difficulty per address
        const addressShares = new Map<string, number>();
        for (const entry of entries) {
            const parts = entry.split(':');
            const addr = parts[0];
            const diff = parseFloat(parts[1]) || 0;
            addressShares.set(addr, (addressShares.get(addr) ?? 0) + diff);
        }

        // 3. Load pending balances
        const pendingEntities = await this.balanceService.getAllWithPending();
        const pendingBalances = new Map<string, number>();
        for (const e of pendingEntities) {
            pendingBalances.set(e.address, e.pendingSats);
        }

        // 4. Delegate the math to the shared pure builder. Handles:
        //    - pending settled out of miner cut (no bad-cb-amount)
        //    - sub-dust filter + weight-budget trim
        //    - fee dust-gate
        //    - remainder sweep
        //    - fallback-to-fee-100% when no usable work
        const { payouts } = buildCoinbaseDistribution({
            addressShares,
            pendingBalances,
            blockRewardSats,
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
            logLabel: '[PPLNS]',
        });

        const result = payouts.length > 0 ? payouts : this.fallbackDistribution();

        // Cache the result
        this.cachedDistribution = result;
        this.cachedDistributionReward = blockRewardSats;
        this.cachedDistributionAt = Date.now();

        // Save snapshot to Redis — onBlockFound will use it for bookkeeping.
        await this.writeSnapshot({ distribution: result, blockRewardSats });

        return result;
    }

    private async writeSnapshot(snapshot: { distribution: PplnsPayoutEntry[]; blockRewardSats: number }): Promise<void> {
        try {
            await this.redis.set(REDIS_KEY_SNAPSHOT, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL_SECONDS });
        } catch {
            // Older node-redis / ioredis variants don't accept the options
            // object — fall back to set + expire.
            await this.redis.set(REDIS_KEY_SNAPSHOT, JSON.stringify(snapshot));
            if (typeof this.redis.expire === 'function') {
                await this.redis.expire(REDIS_KEY_SNAPSHOT, SNAPSHOT_TTL_SECONDS);
            }
        }
    }

    private async readSnapshot(): Promise<{ distribution: PplnsPayoutEntry[]; blockRewardSats: number } | null> {
        const raw = await this.redis.get(REDIS_KEY_SNAPSHOT);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    private async deleteSnapshot(): Promise<void> {
        await this.redis.del(REDIS_KEY_SNAPSHOT);
    }

    /**
     * Fallback: all reward goes to pool fee address.
     */
    private fallbackDistribution(): PplnsPayoutEntry[] {
        if (this.feeAddress) {
            return [{ address: this.feeAddress, percent: 100 }];
        }
        return [];
    }

    // ── Block Found ──────────────────────────────────────────────

    /**
     * Called when a block is found on a PPLNS port.
     * Uses the coinbase snapshot (the distribution that was actually used to build the coinbase)
     * so bookkeeping matches exactly what's on-chain.
     *
     * Idempotency: every history-write + balance-update happens inside one
     * Postgres transaction, guarded by a pre-check on
     * pplns_payout_history.blockHeight. A crash mid-processing rolls back
     * the whole TX — no partial state. On restart the pre-check sees no
     * rows and replays cleanly. Defense-in-depth: the unique index on
     * (blockHeight, address) would surface 23505 even if the pre-check
     * ever raced.
     */
    async onBlockFound(blockHeight: number, blockRewardSats: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        // Invalidate cache — pending balances are about to change
        this.cachedDistribution = null;

        // Prevent concurrent block-found processing (multiple miners finding a block simultaneously)
        if (this.blockFoundInProgress) {
            console.warn(`[PPLNS] Block ${blockHeight} — skipping, another block-found is already being processed`);
            return;
        }
        this.blockFoundInProgress = true;

        try {
            // Idempotency pre-check: a prior onBlockFound for this block
            // already wrote rows → don't replay (would only be caught by
            // the 23505 below otherwise, but pre-check avoids the abort).
            const alreadyProcessed = await this.payoutHistoryRepo.findOneBy({ blockHeight });
            if (alreadyProcessed) {
                console.log(`[PPLNS] Block ${blockHeight} already processed — skipping replay`);
                return;
            }

            console.log(`[PPLNS] Block ${blockHeight} found! Processing payouts...`);

            // Use the coinbase snapshot — this is the exact distribution that went into the block.
            // If no snapshot exists (e.g. first block, or Redis flushed), fall back to recalculating.
            const snapshot = await this.readSnapshot();
            if (!snapshot || snapshot.distribution.length === 0) {
                console.warn(`[PPLNS] No coinbase snapshot available for block ${blockHeight} — falling back to window recalculation`);
                await this.onBlockFoundFromWindow(blockHeight, blockRewardSats);
                return;
            }

            // Snapshot is consumed only after the TX commits (delete after),
            // so a crash mid-TX leaves it for replay.

            const reward = snapshot.blockRewardSats;
            const snapshotAddresses = new Set(snapshot.distribution.map(d => d.address));
            const windowEntries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);

            try {
                await this.payoutHistoryRepo.manager.transaction(async (em) => {
                    const historyRepo = em.getRepository(PplnsPayoutHistoryEntity);
                    const balanceRepo = em.getRepository(PplnsBalanceEntity);

                    for (const entry of snapshot.distribution) {
                        const paidSats = Math.floor((entry.percent / 100) * reward);
                        const isFee = entry.address === this.feeAddress;

                        if (!isFee) {
                            const balance = await balanceRepo.findOneBy({ address: entry.address });
                            if (balance && balance.pendingSats > 0) {
                                balance.totalPaidSats += balance.pendingSats;
                                balance.pendingSats = 0;
                                await balanceRepo.save(balance);
                            }
                        }

                        await historyRepo.save(historyRepo.create({
                            blockHeight, address: entry.address, paidSats, percent: entry.percent, inCoinbase: true,
                        }));

                        if (isFee) {
                            console.log(`[PPLNS]   ${entry.address}: ${paidSats} sats (pool fee, ${entry.percent.toFixed(2)}%)`);
                        } else {
                            console.log(`[PPLNS]   ${entry.address}: ${paidSats} sats (paid in coinbase, ${entry.percent.toFixed(2)}%)`);
                        }
                    }

                    // Miners in the current window but NOT in the snapshot: sub-dust
                    // or trimmed by weight-budget. Credit their proportional cut to
                    // pending so it accumulates for a future block.
                    if (windowEntries && windowEntries.length > 0) {
                        const addressDiff = new Map<string, number>();
                        let totalDiff = 0;
                        for (const e of windowEntries) {
                            const parts = e.split(':');
                            const diff = parseFloat(parts[1]) || 0;
                            addressDiff.set(parts[0], (addressDiff.get(parts[0]) ?? 0) + diff);
                            totalDiff += diff;
                        }

                        const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * reward);
                        for (const [addr, diff] of addressDiff) {
                            if (snapshotAddresses.has(addr)) continue;
                            const sats = Math.floor((diff / totalDiff) * rewardForMiners);
                            if (sats > 0) {
                                const existing = await balanceRepo.findOneBy({ address: addr });
                                if (existing) {
                                    existing.pendingSats += sats;
                                    await balanceRepo.save(existing);
                                } else {
                                    await balanceRepo.save(balanceRepo.create({
                                        address: addr, pendingSats: sats, totalPaidSats: 0,
                                    }));
                                }
                                await historyRepo.save(historyRepo.create({
                                    blockHeight, address: addr, paidSats: sats, percent: (diff / totalDiff) * (100 - this.feePercent), inCoinbase: false,
                                }));
                                console.log(`[PPLNS]   ${addr}: ${sats} sats → pending (not in coinbase)`);
                            }
                        }
                    }
                });
            } catch (e: any) {
                // Unique-violation on (blockHeight, address) — some other
                // process (clustered pool?) processed this block already.
                // Safe to skip; pre-check catches the normal replay case.
                if (e?.code === '23505') {
                    console.warn(`[PPLNS] Block ${blockHeight} raced against duplicate write — skipping (23505)`);
                    return;
                }
                throw e;
            }

            // Snapshot consumed only after the TX committed.
            await this.deleteSnapshot();

            console.log(`[PPLNS] Block ${blockHeight} payouts processed (from coinbase snapshot)`);
        } finally {
            this.blockFoundInProgress = false;
        }
    }

    /**
     * Fallback: recalculate from current window when no snapshot is available.
     * All writes atomic in one TX so a crash mid-processing leaves no partial
     * state (the pre-check in onBlockFound guards replay).
     */
    private async onBlockFoundFromWindow(blockHeight: number, blockRewardSats: number): Promise<void> {
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (!entries || entries.length === 0) return;

        const addressDiff = new Map<string, number>();
        let totalDiff = 0;
        for (const entry of entries) {
            const parts = entry.split(':');
            addressDiff.set(parts[0], (addressDiff.get(parts[0]) ?? 0) + (parseFloat(parts[1]) || 0));
            totalDiff += parseFloat(parts[1]) || 0;
        }
        if (totalDiff <= 0) return;

        const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * blockRewardSats);
        const pendingEntities = await this.balanceService.getAllWithPending();
        const totalPending = pendingEntities.reduce((s, e) => s + (e.pendingSats ?? 0), 0);
        const effectiveMinerReward = Math.max(0, rewardForMiners - totalPending);

        try {
            await this.payoutHistoryRepo.manager.transaction(async (em) => {
                const historyRepo = em.getRepository(PplnsPayoutHistoryEntity);
                const balanceRepo = em.getRepository(PplnsBalanceEntity);

                for (const [addr, diff] of addressDiff) {
                    const ratio = diff / totalDiff;
                    const sats = Math.floor(ratio * effectiveMinerReward);
                    const balance = await balanceRepo.findOneBy({ address: addr });
                    const pending = balance?.pendingSats ?? 0;
                    const totalSats = sats + pending;
                    const percent = (totalSats / blockRewardSats) * 100;

                    if (totalSats >= DUST_LIMIT_SATS) {
                        if (balance && pending > 0) {
                            balance.totalPaidSats += pending;
                            balance.pendingSats = 0;
                            await balanceRepo.save(balance);
                        }
                        await historyRepo.save(historyRepo.create({
                            blockHeight, address: addr, paidSats: totalSats, percent, inCoinbase: true,
                        }));
                    } else if (sats > 0) {
                        if (balance) {
                            balance.pendingSats += sats;
                            await balanceRepo.save(balance);
                        } else {
                            await balanceRepo.save(balanceRepo.create({
                                address: addr, pendingSats: sats, totalPaidSats: 0,
                            }));
                        }
                        await historyRepo.save(historyRepo.create({
                            blockHeight, address: addr, paidSats: sats, percent, inCoinbase: false,
                        }));
                    }
                }

                // Pending-only addresses (not mining this round, ≥ dust) —
                // pay them out in the coinbase.
                const processed = new Set(addressDiff.keys());
                for (const entity of pendingEntities) {
                    if (processed.has(entity.address)) continue;
                    if (entity.pendingSats >= DUST_LIMIT_SATS) {
                        const row = await balanceRepo.findOneBy({ address: entity.address });
                        if (row) {
                            row.totalPaidSats += row.pendingSats;
                            const paidAmount = row.pendingSats;
                            row.pendingSats = 0;
                            await balanceRepo.save(row);
                            await historyRepo.save(historyRepo.create({
                                blockHeight, address: entity.address, paidSats: paidAmount,
                                percent: (paidAmount / blockRewardSats) * 100, inCoinbase: true,
                            }));
                        }
                    }
                }

                if (this.feeAddress) {
                    const feeSats = Math.floor((this.feePercent / 100) * blockRewardSats);
                    if (feeSats >= DUST_LIMIT_SATS) {
                        await historyRepo.save(historyRepo.create({
                            blockHeight, address: this.feeAddress, paidSats: feeSats,
                            percent: this.feePercent, inCoinbase: true,
                        }));
                    } else {
                        console.warn(`[PPLNS] Fallback: fee output ${feeSats} sats < dust — omitting fee history row`);
                    }
                }
            });
        } catch (e: any) {
            if (e?.code === '23505') {
                console.warn(`[PPLNS] Block ${blockHeight} (fallback) raced against duplicate write — skipping (23505)`);
                return;
            }
            throw e;
        }
    }

    // ── Stats ────────────────────────────────────────────────────

    async getWindowStats(): Promise<{
        totalDifficulty: number;
        windowSize: number;
        shareCount: number;
        minerCount: number;
    }> {
        if (!this.redis) {
            return { totalDifficulty: 0, windowSize: 0, shareCount: 0, minerCount: 0 };
        }

        const totalStr = await this.redis.get(REDIS_KEY_WINDOW_TOTAL);
        const shareCount = await this.redis.zCard(REDIS_KEY_SHARES);
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        const miners = new Set<string>();
        for (const entry of (entries ?? [])) {
            miners.add(entry.split(':')[0]);
        }

        return {
            totalDifficulty: parseFloat(totalStr) || 0,
            windowSize: this.getWindowSize(),
            shareCount: shareCount ?? 0,
            minerCount: miners.size,
        };
    }

    /**
     * Get PPLNS status for a specific address.
     */
    async getAddressStatus(address: string): Promise<{
        pendingSats: number;
        totalPaidSats: number;
        currentWindowDifficulty: number;
        currentWindowPercent: number;
    }> {
        const balance = await this.balanceService.getBalance(address);

        let currentWindowDifficulty = 0;
        let currentWindowPercent = 0;

        if (this.redis) {
            const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
            let totalDiff = 0;
            let addressDiff = 0;
            for (const entry of (entries ?? [])) {
                const parts = entry.split(':');
                const diff = parseFloat(parts[1]) || 0;
                totalDiff += diff;
                if (parts[0] === address) {
                    addressDiff += diff;
                }
            }
            currentWindowDifficulty = addressDiff;
            if (totalDiff > 0) {
                currentWindowPercent = (addressDiff / totalDiff) * 100;
            }
        }

        return {
            pendingSats: balance?.pendingSats ?? 0,
            totalPaidSats: balance?.totalPaidSats ?? 0,
            currentWindowDifficulty,
            currentWindowPercent,
        };
    }

    /**
     * Get current distribution (all miners and their share).
     * `totalShares` is diff-1-weighted real work, not raw share count.
     */
    async getCurrentDistribution(): Promise<{ address: string; totalShares: number; percent: number }[]> {
        if (!this.redis) return [];

        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (!entries || entries.length === 0) return [];

        const addressShares = new Map<string, number>();
        let totalShares = 0;
        for (const entry of entries) {
            const parts = entry.split(':');
            const shares = parseFloat(parts[1]) || 0;
            addressShares.set(parts[0], (addressShares.get(parts[0]) ?? 0) + shares);
            totalShares += shares;
        }

        return Array.from(addressShares.entries())
            .map(([address, shares]) => ({
                address,
                totalShares: shares,
                percent: totalShares > 0 ? (shares / totalShares) * 100 : 0,
            }))
            .sort((a, b) => b.percent - a.percent);
    }

    /**
     * Get payout history for an address.
     */
    async getPayoutHistory(address: string, limit = 50): Promise<PplnsPayoutHistoryEntity[]> {
        return this.payoutHistoryRepo.find({
            where: { address },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }
}
