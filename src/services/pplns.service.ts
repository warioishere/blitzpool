import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { PplnsBalanceService } from '../ORM/pplns-balance/pplns-balance.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

/**
 * PPLNS (Pay Per Last N Shares) engine.
 *
 * Tracks shares in a Redis sorted set and computes coinbase payout
 * distributions.  Window size = 4 * network_difficulty (diff1-equivalent).
 *
 * Only active when PPLNS_PORT is configured.
 */

const PPLNS_WINDOW_FACTOR = 4;
const DUST_LIMIT_SATS = 546; // P2PKH dust; P2WPKH is 294 but use higher for safety
const REDIS_KEY_SHARES = 'pplns:shares';
const REDIS_KEY_COUNTER = 'pplns:counter';
const REDIS_KEY_WINDOW_TOTAL = 'pplns:window:total';

// Coinbase weight budget — must match bitcoin.conf blockreservedweight
const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000; // WU — fits ~400 P2WPKH outputs
const COINBASE_BASE_WEIGHT = 320; // Approx: input + witness + OP_RETURN commitment
const COINBASE_OUTPUT_WEIGHT = 124; // Per P2WPKH output: (8 value + 1 len + 22 script) * 4

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
    private readonly isPrimaryInstance: boolean;
    private readonly coinbaseWeightBudget: number;

    // Distribution cache — avoids re-reading entire Redis sorted set on every job
    private cachedDistribution: PplnsPayoutEntry[] | null = null;
    private cachedDistributionReward = 0;
    private cachedDistributionAt = 0;
    private static readonly DISTRIBUTION_CACHE_TTL_MS = 30_000; // 30 seconds max

    // Coinbase snapshot — the distribution that was actually used to build the latest coinbase.
    // onBlockFound uses this instead of recalculating, so bookkeeping matches on-chain reality.
    private coinbaseSnapshot: { distribution: PplnsPayoutEntry[]; blockRewardSats: number } | null = null;

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

        // PM2 cluster safety: only primary instance processes block payouts
        const pm2InstanceId = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID;
        const normalized = typeof pm2InstanceId === 'string' ? pm2InstanceId.trim() : undefined;
        this.isPrimaryInstance = !normalized || normalized === '0';
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
     * Max miner outputs that fit in the coinbase weight budget.
     */
    getMaxCoinbaseOutputs(): number {
        const feeOutputCount = this.feeAddress ? 1 : 0;
        return Math.floor(
            (this.coinbaseWeightBudget - COINBASE_BASE_WEIGHT - (feeOutputCount + 1) * COINBASE_OUTPUT_WEIGHT) / COINBASE_OUTPUT_WEIGHT,
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
        const addressDiff = new Map<string, number>();
        let totalDiff = 0;

        for (const entry of entries) {
            const parts = entry.split(':');
            const addr = parts[0];
            const diff = parseFloat(parts[1]) || 0;
            addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
            totalDiff += diff;
        }

        if (totalDiff <= 0) {
            return this.fallbackDistribution();
        }

        // 3. Calculate pool fee
        const feePercent = this.feePercent;
        const minerPercent = 100 - feePercent;

        // 4. Calculate sat amounts per miner and handle dust/pending
        const rewardForMiners = Math.floor((minerPercent / 100) * blockRewardSats);
        const payouts: PplnsPayoutEntry[] = [];
        let totalAssignedPercent = 0;

        // Load pending balances
        const pendingEntities = await this.balanceService.getAllWithPending();
        const pendingMap = new Map<string, number>();
        for (const e of pendingEntities) {
            pendingMap.set(e.address, e.pendingSats);
        }

        // Calculate each miner's share
        const minerShares: { address: string; sats: number; percent: number }[] = [];
        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const baseSats = Math.floor(ratio * rewardForMiners);
            const pendingSats = pendingMap.get(addr) ?? 0;
            const totalSats = baseSats + pendingSats;
            const percent = (totalSats / blockRewardSats) * 100;

            minerShares.push({ address: addr, sats: totalSats, percent });
        }

        // Also include addresses with pending balance that have NO shares in current window
        for (const [addr, pending] of pendingMap) {
            if (!addressDiff.has(addr) && pending >= DUST_LIMIT_SATS) {
                // This miner has accumulated enough from previous blocks
                const percent = (pending / blockRewardSats) * 100;
                minerShares.push({ address: addr, sats: pending, percent });
            }
        }

        // Separate into coinbase-eligible (>= dust) and pending (< dust)
        const eligible = minerShares
            .filter(ms => ms.sats >= DUST_LIMIT_SATS)
            .sort((a, b) => b.sats - a.sats); // largest first

        // 5. Coinbase weight check — trim smallest outputs if coinbase would exceed budget
        // +1 for fee output, +1 for OP_RETURN witness commitment
        const feeOutputCount = this.feeAddress ? 1 : 0;
        const maxMinerOutputs = Math.floor(
            (this.coinbaseWeightBudget - COINBASE_BASE_WEIGHT - (feeOutputCount + 1) * COINBASE_OUTPUT_WEIGHT) / COINBASE_OUTPUT_WEIGHT,
        );

        let trimmed = eligible;
        if (eligible.length > maxMinerOutputs && maxMinerOutputs > 0) {
            trimmed = eligible.slice(0, maxMinerOutputs);
            const removedCount = eligible.length - maxMinerOutputs;
            console.warn(`[PPLNS] Coinbase weight limit: trimmed ${removedCount} smallest outputs to pending (${eligible.length} → ${trimmed.length} outputs, budget ${this.coinbaseWeightBudget} WU)`);
        }

        for (const ms of trimmed) {
            payouts.push({ address: ms.address, percent: ms.percent });
            totalAssignedPercent += ms.percent;
        }

        // 6. Add pool fee
        if (this.feeAddress) {
            payouts.unshift({ address: this.feeAddress, percent: feePercent });
            totalAssignedPercent += feePercent;
        }

        // 6. Ensure percentages sum to ~100 — assign remainder to fee address
        if (payouts.length > 0 && totalAssignedPercent < 100) {
            const remainder = 100 - totalAssignedPercent;
            if (this.feeAddress) {
                payouts[0].percent += remainder;
            } else {
                payouts[payouts.length - 1].percent += remainder;
            }
        }

        const result = payouts.length > 0 ? payouts : this.fallbackDistribution();

        // Cache the result
        this.cachedDistribution = result;
        this.cachedDistributionReward = blockRewardSats;
        this.cachedDistributionAt = Date.now();

        // Save snapshot — onBlockFound will use this for bookkeeping
        this.coinbaseSnapshot = { distribution: result, blockRewardSats };

        return result;
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
     */
    async onBlockFound(blockHeight: number, blockRewardSats: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        // Invalidate cache — pending balances are about to change
        this.cachedDistribution = null;

        // PM2 cluster: only primary instance processes payouts to avoid double-crediting
        if (!this.isPrimaryInstance) {
            console.log(`[PPLNS] Block ${blockHeight} found — skipping payout processing (non-primary PM2 instance)`);
            return;
        }

        // Prevent concurrent block-found processing (multiple miners finding a block simultaneously)
        if (this.blockFoundInProgress) {
            console.warn(`[PPLNS] Block ${blockHeight} — skipping, another block-found is already being processed`);
            return;
        }
        this.blockFoundInProgress = true;

        try {
        console.log(`[PPLNS] Block ${blockHeight} found! Processing payouts...`);

        // Use the coinbase snapshot — this is the exact distribution that went into the block.
        // If no snapshot exists (e.g. first block, or race condition), fall back to recalculating.
        const snapshot = this.coinbaseSnapshot;
        if (!snapshot || snapshot.distribution.length === 0) {
            console.warn(`[PPLNS] No coinbase snapshot available for block ${blockHeight} — falling back to window recalculation`);
            await this.onBlockFoundFromWindow(blockHeight, blockRewardSats);
            return;
        }

        // Clear snapshot — it's been consumed
        this.coinbaseSnapshot = null;

        const reward = snapshot.blockRewardSats;

        for (const entry of snapshot.distribution) {
            if (entry.address === this.feeAddress) {
                // Log pool fee
                const feeSats = Math.floor((entry.percent / 100) * reward);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: entry.address, paidSats: feeSats, percent: entry.percent, inCoinbase: true,
                }));
                console.log(`[PPLNS]   ${entry.address}: ${feeSats} sats (pool fee, ${entry.percent.toFixed(2)}%)`);
                continue;
            }

            const paidSats = Math.floor((entry.percent / 100) * reward);
            const pending = await this.balanceService.getPending(entry.address);

            // This address was in the coinbase — mark any pending as paid
            if (pending > 0) {
                await this.balanceService.markPaid(entry.address, pending);
            }

            await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                blockHeight, address: entry.address, paidSats, percent: entry.percent, inCoinbase: true,
            }));
            console.log(`[PPLNS]   ${entry.address}: ${paidSats} sats (paid in coinbase, ${entry.percent.toFixed(2)}%)`);
        }

        // Handle miners NOT in the snapshot (sub-dust or trimmed by weight limit)
        // Their share from the current window goes to pending
        const snapshotAddresses = new Set(snapshot.distribution.map(d => d.address));
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (entries && entries.length > 0) {
            const addressDiff = new Map<string, number>();
            let totalDiff = 0;
            for (const e of entries) {
                const parts = e.split(':');
                const diff = parseFloat(parts[1]) || 0;
                addressDiff.set(parts[0], (addressDiff.get(parts[0]) ?? 0) + diff);
                totalDiff += diff;
            }

            const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * reward);
            for (const [addr, diff] of addressDiff) {
                if (snapshotAddresses.has(addr)) continue; // Already processed above
                const sats = Math.floor((diff / totalDiff) * rewardForMiners);
                if (sats > 0) {
                    await this.balanceService.addPending(addr, sats);
                    await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                        blockHeight, address: addr, paidSats: sats, percent: (diff / totalDiff) * (100 - this.feePercent), inCoinbase: false,
                    }));
                    console.log(`[PPLNS]   ${addr}: ${sats} sats → pending (not in coinbase)`);
                }
            }
        }

        console.log(`[PPLNS] Block ${blockHeight} payouts processed (from coinbase snapshot)`);
        } finally {
            this.blockFoundInProgress = false;
        }
    }

    /**
     * Fallback: recalculate from current window when no snapshot is available.
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

        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const sats = Math.floor(ratio * rewardForMiners);
            const pending = await this.balanceService.getPending(addr);
            const totalSats = sats + pending;
            const percent = ratio * (100 - this.feePercent);

            if (totalSats >= DUST_LIMIT_SATS) {
                if (pending > 0) await this.balanceService.markPaid(addr, pending);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: addr, paidSats: totalSats, percent, inCoinbase: true,
                }));
            } else {
                if (sats > 0) await this.balanceService.addPending(addr, sats);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: addr, paidSats: sats, percent, inCoinbase: false,
                }));
            }
        }

        // Pending-only addresses
        const pendingEntities = await this.balanceService.getAllWithPending();
        const processed = new Set(addressDiff.keys());
        for (const entity of pendingEntities) {
            if (processed.has(entity.address)) continue;
            if (entity.pendingSats >= DUST_LIMIT_SATS) {
                await this.balanceService.markPaid(entity.address, entity.pendingSats);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: entity.address, paidSats: entity.pendingSats,
                    percent: (entity.pendingSats / blockRewardSats) * 100, inCoinbase: true,
                }));
            }
        }

        const feeSats = blockRewardSats - rewardForMiners;
        if (this.feeAddress) {
            await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                blockHeight, address: this.feeAddress, paidSats: feeSats, percent: this.feePercent, inCoinbase: true,
            }));
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
     */
    async getCurrentDistribution(): Promise<{ address: string; difficulty: number; percent: number }[]> {
        if (!this.redis) return [];

        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (!entries || entries.length === 0) return [];

        const addressDiff = new Map<string, number>();
        let totalDiff = 0;
        for (const entry of entries) {
            const parts = entry.split(':');
            const diff = parseFloat(parts[1]) || 0;
            addressDiff.set(parts[0], (addressDiff.get(parts[0]) ?? 0) + diff);
            totalDiff += diff;
        }

        return Array.from(addressDiff.entries())
            .map(([address, difficulty]) => ({
                address,
                difficulty,
                percent: totalDiff > 0 ? (difficulty / totalDiff) * 100 : 0,
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
