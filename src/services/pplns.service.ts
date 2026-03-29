import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PplnsBalanceService } from '../ORM/pplns-balance/pplns-balance.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';

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

export interface PplnsPayoutEntry {
    address: string;
    percent: number;
}

@Injectable()
export class PplnsService implements OnModuleInit {
    private redis: any = null;
    private enabled = false;
    private feeAddress: string;
    private feePercent: number;
    private networkDifficulty = 0;

    constructor(
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly balanceService: PplnsBalanceService,
        @InjectRepository(PplnsPayoutHistoryEntity)
        private readonly payoutHistoryRepo: Repository<PplnsPayoutHistoryEntity>,
    ) {
        this.feeAddress = this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(this.configService.get('PPLNS_FEE_PERCENT') ?? '2');
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
        for (const ms of minerShares) {
            if (ms.sats >= DUST_LIMIT_SATS) {
                payouts.push({ address: ms.address, percent: ms.percent });
                totalAssignedPercent += ms.percent;
            }
            // Sub-dust amounts are handled in onBlockFound()
        }

        // 5. Add pool fee
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

        return payouts.length > 0 ? payouts : this.fallbackDistribution();
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
     * Updates pending balances for sub-dust miners and marks paid for others.
     */
    async onBlockFound(blockHeight: number, blockRewardSats: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        console.log(`[PPLNS] Block ${blockHeight} found! Processing payouts...`);

        // Read current window
        const entries = await this.redis.zRange(REDIS_KEY_SHARES, 0, -1);
        if (!entries || entries.length === 0) return;

        // Sum difficulty per address
        const addressDiff = new Map<string, number>();
        let totalDiff = 0;

        for (const entry of entries) {
            const parts = entry.split(':');
            const addr = parts[0];
            const diff = parseFloat(parts[1]) || 0;
            addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
            totalDiff += diff;
        }

        if (totalDiff <= 0) return;

        const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * blockRewardSats);

        // Track which pending addresses we've already processed
        const processedAddresses = new Set<string>();

        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const sats = Math.floor(ratio * rewardForMiners);
            const pending = await this.balanceService.getPending(addr);
            const totalSats = sats + pending;

            const percent = (ratio * (100 - this.feePercent));
            processedAddresses.add(addr);

            if (totalSats >= DUST_LIMIT_SATS) {
                // Was included in coinbase — mark pending as paid
                if (pending > 0) {
                    await this.balanceService.markPaid(addr, pending);
                }
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: addr, paidSats: totalSats, percent, inCoinbase: true,
                }));
                console.log(`[PPLNS]   ${addr}: ${totalSats} sats (paid in coinbase, ${percent.toFixed(2)}%)`);
            } else {
                // Below dust — accumulate
                await this.balanceService.addPending(addr, sats);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: addr, paidSats: sats, percent, inCoinbase: false,
                }));
                console.log(`[PPLNS]   ${addr}: ${sats} sats → pending (total: ${sats + pending})`);
            }
        }

        // Process pending-only addresses (no current shares but pending >= dust was in coinbase)
        const pendingEntities = await this.balanceService.getAllWithPending();
        for (const entity of pendingEntities) {
            if (processedAddresses.has(entity.address)) continue;
            if (entity.pendingSats >= DUST_LIMIT_SATS) {
                // This address was included in coinbase via getPayoutDistribution() — mark as paid
                const paidAmount = entity.pendingSats;
                await this.balanceService.markPaid(entity.address, paidAmount);
                await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                    blockHeight, address: entity.address, paidSats: paidAmount, percent: (paidAmount / blockRewardSats) * 100, inCoinbase: true,
                }));
                console.log(`[PPLNS]   ${entity.address}: ${paidAmount} sats (pending-only, paid in coinbase)`);
            }
        }

        // Log pool fee
        const feeSats = blockRewardSats - rewardForMiners;
        if (this.feeAddress) {
            await this.payoutHistoryRepo.save(this.payoutHistoryRepo.create({
                blockHeight, address: this.feeAddress, paidSats: feeSats, percent: this.feePercent, inCoinbase: true,
            }));
        }

        console.log(`[PPLNS] Block ${blockHeight} payouts processed for ${addressDiff.size} miners`);
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
