import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
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
// Per-address diff-1 aggregate for the current window. Maintained in lock-
// step with REDIS_KEY_SHARES: recordShare increments, trimWindow decrements.
// Hot-path readers (getPayoutDistribution, onBlockFound) use hGetAll on this
// hash instead of zRange 0 -1 over the raw share set, so lookup cost is O(N
// distinct miners) rather than O(M individual shares). At 2 000 miners ×
// ~1 share/second the raw set holds >1M entries in a normal window — the
// aggregate is a handful of kilobytes.
//
// Drift: hIncrByFloat accumulates float error over very long runs. Same
// failsafe as REDIS_KEY_WINDOW_TOTAL — every 1000 trims we do a full
// recalculate from REDIS_KEY_SHARES to reset accumulated drift.
const REDIS_KEY_WINDOW_BY_ADDRESS = 'pplns:window:by-address';
// Coinbase snapshot — JSON-encoded distribution that was actually used to
// build the latest coinbase. Persisted in Redis (not an in-memory Map) so
// a pool restart between getPayoutDistribution and onBlockFound doesn't
// lose it and force onBlockFoundFromWindow (whose distribution can differ
// from what's already on-chain).
//
// `consideredAddresses` captures every address that was in addressShares
// or pendingBalances at snapshot-build time (including sub-dust miners
// filtered out of the coinbase). onBlockFound uses it to distinguish two
// classes of "not in coinbase" miners — sub-dust (was considered, credit
// to pending) vs late arriver (submitted after snapshot, audit only).
// Without this, late-arriver shares get credited to pending AND stay in
// the sliding window for future blocks → double-paid. Same fix pattern
// as group-solo (commit 6ace1b8).
const REDIS_KEY_SNAPSHOT = 'pplns:snapshot';
const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block-find + restart window.

interface StoredPplnsSnapshot {
    distribution: PplnsPayoutEntry[];
    blockRewardSats: number;
    consideredAddresses: string[];
}

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
        // Maintain the per-address aggregate in lock-step with the raw
        // share set so hot-path readers can skip the zRange 0 -1 scan.
        await this.redis.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, address, difficulty);

        // Invalidate cached distribution — share weights changed
        this.cachedDistribution = null;

        // Keep pplns_balance.lastAcceptedShareAt fresh so the dust-sweep
        // cron can distinguish "miner still active" from "dormant pending
        // leftover". No-op if the miner has no balance row yet.
        this.balanceService.touchLastAcceptedShareAt(address).catch(err => {
            console.warn(`[PPLNS] touchLastAcceptedShareAt failed for ${address}:`, (err as Error).message);
        });

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
            // Group removed diff per-address so we can decrement the
            // per-address aggregate with one hIncrByFloat per miner
            // instead of one per share.
            const removedByAddr = new Map<string, number>();
            for (const entry of oldest) {
                const parts = entry.split(':');
                const diff = parseFloat(parts[1]) || 0;
                removedDiff += diff;
                removedByAddr.set(parts[0], (removedByAddr.get(parts[0]) ?? 0) + diff);
            }

            await this.redis.zRemRangeByRank(REDIS_KEY_SHARES, 0, oldest.length - 1);
            total -= removedDiff;

            for (const [addr, d] of removedByAddr) {
                await this.redis.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, addr, -d);
            }
        }

        this.trimCounter++;

        // Every 1000 trims, recalculate total + per-address aggregate from
        // the raw sorted set to fix accumulated float drift. Same failsafe
        // cadence as the existing window-total recalc.
        if (this.trimCounter % 1000 === 0) {
            total = await this.recalculateWindowTotal();
            await this.recalculateWindowByAddress();
        }

        await this.redis.set(REDIS_KEY_WINDOW_TOTAL, total.toString());
    }

    /**
     * Recalculate the per-address window aggregate by scanning the raw
     * sorted set. Expensive (O(M shares)) but runs at most every 1000
     * trims, so amortized cost per share is tiny. Zero-or-negative entries
     * are removed from the hash to keep `hGetAll` cheap for downstream
     * readers.
     */
    private async recalculateWindowByAddress(): Promise<void> {
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        const byAddr = new Map<string, number>();
        for (const entry of (entries ?? [])) {
            const parts = entry.split(':');
            const diff = parseFloat(parts[1]) || 0;
            byAddr.set(parts[0], (byAddr.get(parts[0]) ?? 0) + diff);
        }
        // Rebuild atomically: clear then repopulate. At the volumes the
        // recalc runs (every 1000 trims), the brief hGetAll-miss window
        // is a non-issue — getPayoutDistribution returns fallback-to-fee
        // if the aggregate reads empty, and the next recordShare repopulates.
        await this.redis.del(REDIS_KEY_WINDOW_BY_ADDRESS);
        for (const [addr, diff] of byAddr) {
            if (diff > 0) {
                await this.redis.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, addr, diff);
            }
        }
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

    /**
     * Read the current PPLNS window grouped by address. Uses the
     * per-address aggregate hash (O(distinct miners)) instead of scanning
     * the raw sorted set (O(M shares) — can be millions at scale). Falls
     * back to the sorted-set scan if the aggregate is empty, which covers
     * pre-this-optimization Redis state and edge cases right after a
     * recalculate.
     */
    private async readWindowByAddress(): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        const hash = (await this.redis.hGetAll(REDIS_KEY_WINDOW_BY_ADDRESS)) ?? {};
        for (const [addr, diffStr] of Object.entries(hash)) {
            const diff = parseFloat(diffStr as string) || 0;
            if (diff > 0) out.set(addr, diff);
        }
        if (out.size > 0) return out;
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        for (const entry of (entries ?? [])) {
            const parts = entry.split(':');
            const diff = parseFloat(parts[1]) || 0;
            out.set(parts[0], (out.get(parts[0]) ?? 0) + diff);
        }
        return out;
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

        // 1. Read per-address aggregate (O(distinct miners), not O(shares)).
        //    recordShare / trimWindow keep this in lock-step with the raw
        //    share set. readWindowByAddress handles legacy-state fallback
        //    to the sorted-set scan.
        const addressShares = await this.readWindowByAddress();
        if (addressShares.size === 0) {
            return this.fallbackDistribution();
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
        const { payouts, consideredAddresses } = buildCoinbaseDistribution({
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
        // consideredAddresses distinguishes sub-dust (was in the window at
        // snapshot time) from late arrivers (submitted after), preventing
        // double-credit in the sliding-window PPLNS payout path.
        await this.writeSnapshot({
            distribution: result,
            blockRewardSats,
            consideredAddresses: Array.from(consideredAddresses),
        });

        return result;
    }

    private async writeSnapshot(snapshot: StoredPplnsSnapshot): Promise<void> {
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

    private async readSnapshot(): Promise<{
        distribution: PplnsPayoutEntry[];
        blockRewardSats: number;
        consideredAddresses: Set<string>;
    } | null> {
        const raw = await this.redis.get(REDIS_KEY_SNAPSHOT);
        if (!raw) return null;
        try {
            const parsed: StoredPplnsSnapshot = JSON.parse(raw);
            return {
                distribution: parsed.distribution,
                blockRewardSats: parsed.blockRewardSats,
                // Legacy snapshots (pre-this-fix) don't carry the field.
                // Treat as empty set — every non-snapshot address is then
                // classed as late arriver, which is the safer side (no
                // phantom pending credit) during the rollout transition.
                consideredAddresses: new Set(parsed.consideredAddresses ?? []),
            };
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

            // Defensive check: if the block's reward doesn't match the snapshot's
            // reward, the snapshot was built for a different job (e.g. coinbasevalue
            // changed between concurrent jobs as mempool churned). Booking payouts
            // against the wrong distribution would drift from on-chain reality, so
            // fall back to the window-recalc path — it produces its own fresh
            // distribution from the current window and uses the real blockReward.
            if (snapshot.blockRewardSats !== blockRewardSats) {
                console.warn(
                    `[PPLNS] Snapshot blockReward ${snapshot.blockRewardSats} != block's `
                    + `${blockRewardSats} — snapshot is for a different job, falling back to window recalc`,
                );
                await this.deleteSnapshot();
                await this.onBlockFoundFromWindow(blockHeight, blockRewardSats);
                return;
            }

            // Snapshot is consumed only after the TX commits (delete after),
            // so a crash mid-TX leaves it for replay.

            const reward = snapshot.blockRewardSats;
            const snapshotAddresses = new Set(snapshot.distribution.map(d => d.address));
            // O(distinct miners), not O(shares) — see readWindowByAddress.
            const windowByAddr = await this.readWindowByAddress();

            try {
                await this.payoutHistoryRepo.manager.transaction(async (em) => {
                    const historyRepo = em.getRepository(PplnsPayoutHistoryEntity);
                    const balanceRepo = em.getRepository(PplnsBalanceEntity);

                    // Single round-trip to fetch every balance row we might
                    // touch, instead of one findOneBy per miner. At 2 000
                    // miners the former is ~2 000 × 2–10 ms (4–40 s per TX)
                    // → an IN-list lookup is a single query.
                    const addrsNeedingBalance = new Set<string>();
                    for (const entry of snapshot.distribution) {
                        if (entry.address !== this.feeAddress) addrsNeedingBalance.add(entry.address);
                    }
                    for (const addr of windowByAddr.keys()) {
                        if (!snapshotAddresses.has(addr) && snapshot.consideredAddresses.has(addr)) {
                            addrsNeedingBalance.add(addr);
                        }
                    }
                    const existingBalances = addrsNeedingBalance.size > 0
                        ? await balanceRepo.find({ where: { address: In(Array.from(addrsNeedingBalance)) } })
                        : [];
                    const balanceMap = new Map(existingBalances.map(b => [b.address, b]));

                    const balancesToSave = new Map<string, PplnsBalanceEntity>();
                    const historyRows: PplnsPayoutHistoryEntity[] = [];

                    // Process snapshot distribution (fee + miners that
                    // made it into the coinbase)
                    for (const entry of snapshot.distribution) {
                        const paidSats = Math.floor((entry.percent / 100) * reward);
                        const isFee = entry.address === this.feeAddress;

                        if (!isFee) {
                            const balance = balanceMap.get(entry.address);
                            if (balance && balance.pendingSats > 0) {
                                balance.totalPaidSats += balance.pendingSats;
                                balance.pendingSats = 0;
                                balancesToSave.set(balance.address, balance);
                            }
                        }

                        historyRows.push(historyRepo.create({
                            blockHeight, address: entry.address, paidSats, percent: entry.percent, inCoinbase: true,
                        }));

                        if (isFee) {
                            console.log(`[PPLNS]   ${entry.address}: ${paidSats} sats (pool fee, ${entry.percent.toFixed(2)}%)`);
                        } else {
                            console.log(`[PPLNS]   ${entry.address}: ${paidSats} sats (paid in coinbase, ${entry.percent.toFixed(2)}%)`);
                        }
                    }

                    // For each window address not in the snapshot distribution,
                    // distinguish:
                    //   - sub-dust / weight-trimmed: was in the window at
                    //     snapshot-build time (consideredAddresses) → credit to
                    //     pending for a future block
                    //   - late arriver: submitted after snapshot build → audit
                    //     row only, NO pending credit. The PPLNS window is
                    //     sliding, so the late arriver's shares stay in the
                    //     window and get paid via the NEXT block's snapshot;
                    //     crediting here in addition would be a double-pay.
                    const totalDiff = Array.from(windowByAddr.values()).reduce((s, v) => s + v, 0);
                    const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * reward);
                    for (const [addr, diff] of windowByAddr) {
                        if (snapshotAddresses.has(addr)) continue;
                        const wasConsidered = snapshot.consideredAddresses.has(addr);
                        if (wasConsidered) {
                            const sats = totalDiff > 0 ? Math.floor((diff / totalDiff) * rewardForMiners) : 0;
                            if (sats > 0) {
                                const now = new Date();
                                let balance = balanceMap.get(addr);
                                if (!balance) {
                                    balance = balanceRepo.create({
                                        address: addr, pendingSats: 0, totalPaidSats: 0,
                                        lastAcceptedShareAt: now,
                                    });
                                    balanceMap.set(addr, balance);
                                }
                                balance.pendingSats += sats;
                                balance.lastAcceptedShareAt = now;
                                balancesToSave.set(balance.address, balance);
                                historyRows.push(historyRepo.create({
                                    blockHeight, address: addr, paidSats: sats, percent: (diff / totalDiff) * (100 - this.feePercent), inCoinbase: false, rowType: 'pending',
                                }));
                                console.log(`[PPLNS]   ${addr}: ${sats} sats → pending (sub-dust / weight-trimmed)`);
                            }
                        } else {
                            // Late arriver — audit row only, no payout.
                            historyRows.push(historyRepo.create({
                                blockHeight, address: addr, paidSats: 0, percent: 0, inCoinbase: false, rowType: 'pending',
                            }));
                            console.log(`[PPLNS]   ${addr}: ${diff.toFixed(2)} shares in window but not in snapshot (late arrival, stays in sliding window for next block)`);
                        }
                    }

                    // Batch persist everything — one save for all balance
                    // rows, one insert for all history rows. Avoids the
                    // O(miners) round-trip explosion of the old per-miner
                    // save() calls.
                    if (balancesToSave.size > 0) {
                        await balanceRepo.save(Array.from(balancesToSave.values()));
                    }
                    if (historyRows.length > 0) {
                        await historyRepo.insert(historyRows);
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
        const addressDiff = await this.readWindowByAddress();
        if (addressDiff.size === 0) return;

        const totalDiff = Array.from(addressDiff.values()).reduce((s, v) => s + v, 0);
        if (totalDiff <= 0) return;

        const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * blockRewardSats);
        const pendingEntities = await this.balanceService.getAllWithPending();
        const totalPending = pendingEntities.reduce((s, e) => s + (e.pendingSats ?? 0), 0);
        const effectiveMinerReward = Math.max(0, rewardForMiners - totalPending);

        try {
            await this.payoutHistoryRepo.manager.transaction(async (em) => {
                const historyRepo = em.getRepository(PplnsPayoutHistoryEntity);
                const balanceRepo = em.getRepository(PplnsBalanceEntity);

                // Single IN-list fetch for every address we might touch
                // — window miners + pending-only miners — instead of one
                // findOneBy per row.
                const addrsNeedingBalance = new Set<string>([
                    ...addressDiff.keys(),
                    ...pendingEntities.map(e => e.address),
                ]);
                const existingBalances = addrsNeedingBalance.size > 0
                    ? await balanceRepo.find({ where: { address: In(Array.from(addrsNeedingBalance)) } })
                    : [];
                const balanceMap = new Map(existingBalances.map(b => [b.address, b]));

                const balancesToSave = new Map<string, PplnsBalanceEntity>();
                const historyRows: PplnsPayoutHistoryEntity[] = [];
                const now = new Date();

                for (const [addr, diff] of addressDiff) {
                    const ratio = diff / totalDiff;
                    const sats = Math.floor(ratio * effectiveMinerReward);
                    let balance = balanceMap.get(addr);
                    const pending = balance?.pendingSats ?? 0;
                    const totalSats = sats + pending;
                    const percent = (totalSats / blockRewardSats) * 100;

                    if (totalSats >= DUST_LIMIT_SATS) {
                        if (balance && pending > 0) {
                            balance.totalPaidSats += pending;
                            balance.pendingSats = 0;
                            balance.lastAcceptedShareAt = now;
                            balancesToSave.set(balance.address, balance);
                        }
                        historyRows.push(historyRepo.create({
                            blockHeight, address: addr, paidSats: totalSats, percent, inCoinbase: true, rowType: 'coinbase',
                        }));
                    } else if (sats > 0) {
                        if (!balance) {
                            balance = balanceRepo.create({
                                address: addr, pendingSats: 0, totalPaidSats: 0,
                                lastAcceptedShareAt: now,
                            });
                            balanceMap.set(addr, balance);
                        }
                        balance.pendingSats += sats;
                        balance.lastAcceptedShareAt = now;
                        balancesToSave.set(balance.address, balance);
                        historyRows.push(historyRepo.create({
                            blockHeight, address: addr, paidSats: sats, percent, inCoinbase: false, rowType: 'pending',
                        }));
                    }
                }

                // Pending-only addresses (not mining this round, ≥ dust) —
                // pay them out in the coinbase.
                const processed = new Set(addressDiff.keys());
                for (const entity of pendingEntities) {
                    if (processed.has(entity.address)) continue;
                    if (entity.pendingSats >= DUST_LIMIT_SATS) {
                        const row = balanceMap.get(entity.address);
                        if (row) {
                            const paidAmount = row.pendingSats;
                            row.totalPaidSats += row.pendingSats;
                            row.pendingSats = 0;
                            balancesToSave.set(row.address, row);
                            historyRows.push(historyRepo.create({
                                blockHeight, address: entity.address, paidSats: paidAmount,
                                percent: (paidAmount / blockRewardSats) * 100, inCoinbase: true,
                            }));
                        }
                    }
                }

                if (this.feeAddress) {
                    const feeSats = Math.floor((this.feePercent / 100) * blockRewardSats);
                    if (feeSats >= DUST_LIMIT_SATS) {
                        historyRows.push(historyRepo.create({
                            blockHeight, address: this.feeAddress, paidSats: feeSats,
                            percent: this.feePercent, inCoinbase: true,
                        }));
                    } else {
                        console.warn(`[PPLNS] Fallback: fee output ${feeSats} sats < dust — omitting fee history row`);
                    }
                }

                if (balancesToSave.size > 0) {
                    await balanceRepo.save(Array.from(balancesToSave.values()));
                }
                if (historyRows.length > 0) {
                    await historyRepo.insert(historyRows);
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
