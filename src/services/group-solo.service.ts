import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { GroupService } from './group.service';

/**
 * Group-solo PROP-style payout engine.
 *
 * - One share window per group, kept in Redis: `groupsolo:{groupId}:shares`.
 * - PROP semantics: the window is cleared on every block-found event.
 * - Distribution: each member's cut = (their shares in round / total shares in round) × (1 - feePercent).
 * - Pool fee (PPLNS_FEE_PERCENT / PPLNS_FEE_ADDRESS) applied before member distribution,
 *   identical to the main PPLNS engine.
 * - Outputs trimmed by coinbase weight budget go to `pplns_group_balance.pendingSats`.
 *
 * Only active when GROUP_SOLO_PORT is configured.
 */

const DUST_LIMIT_SATS = 546;
const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000;
const COINBASE_BASE_WEIGHT = 320;
const COINBASE_OUTPUT_WEIGHT = 124;

function redisKeys(groupId: string) {
    return {
        shares: `groupsolo:${groupId}:shares`,
        counter: `groupsolo:${groupId}:counter`,
        total: `groupsolo:${groupId}:total`,
    };
}

export interface GroupSoloPayoutEntry {
    address: string;
    percent: number;
}

@Injectable()
export class GroupSoloService implements OnModuleInit {

    private redis: any = null;
    private enabled = false;
    private feeAddress: string;
    private feePercent: number;
    private readonly coinbaseWeightBudget: number;

    /** Coinbase snapshot per group — so onBlockFound can match on-chain payouts exactly. */
    private snapshots = new Map<string, { distribution: GroupSoloPayoutEntry[]; blockRewardSats: number }>();

    /** Per-group block-found reentrancy guard. */
    private blockFoundLocks = new Set<string>();

    constructor(
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @InjectRepository(PplnsGroupBlockHistoryEntity)
        private readonly historyRepo: Repository<PplnsGroupBlockHistoryEntity>,
        @InjectRepository(PplnsGroupBalanceEntity)
        private readonly balanceRepo: Repository<PplnsGroupBalanceEntity>,
        private readonly groupService: GroupService,
    ) {
        this.feeAddress = this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(this.configService.get('PPLNS_FEE_PERCENT') ?? '2');
        this.coinbaseWeightBudget = parseInt(
            this.configService.get('PPLNS_COINBASE_WEIGHT_BUDGET') ?? DEFAULT_COINBASE_WEIGHT_BUDGET.toString(),
            10,
        ) || DEFAULT_COINBASE_WEIGHT_BUDGET;
        this.enabled = !!this.configService.get('GROUP_SOLO_PORT');
    }

    async onModuleInit(): Promise<void> {
        if (!this.enabled) return;

        try {
            const store: any = this.cacheManager.store;
            if (store?.client) {
                this.redis = store.client;
                console.log('[GroupSolo] Service initialized with Redis');
            } else {
                console.error('[GroupSolo] Redis not available — group-solo will not function!');
            }
        } catch (error) {
            console.error('[GroupSolo] Failed to access Redis client:', error);
        }
    }

    isEnabled(): boolean {
        return this.enabled && !!this.redis;
    }

    /** Delegate to GroupService — allows stratum layer to query address membership via one service. */
    getGroupForAddress(address: string) {
        return this.groupService.getGroupForAddress(address);
    }

    // ── Share Recording ──────────────────────────────────────────

    /** Record an accepted share from a group-solo miner. Returns false if address is not routable. */
    async recordShare(address: string, difficulty: number): Promise<boolean> {
        if (!this.isEnabled()) return false;
        const entry = this.groupService.getGroupForAddress(address);
        if (!entry || !entry.active) return false;

        const keys = redisKeys(entry.groupId);
        const counter = await this.redis.incr(keys.counter);
        const payload = `${address}:${difficulty}:${Date.now()}`;
        await this.redis.zAdd(keys.shares, { score: counter, value: payload });
        await this.redis.incrByFloat(keys.total, difficulty);
        return true;
    }

    // ── Payout Distribution ──────────────────────────────────────

    /**
     * Build the current round's payout distribution for the given group.
     * Stores a snapshot so onBlockFound can use the exact same split.
     */
    async getPayoutDistribution(groupId: string, blockRewardSats: number): Promise<GroupSoloPayoutEntry[]> {
        if (!this.isEnabled()) return this.fallback();

        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        if (!entries || entries.length === 0) {
            return this.fallback();
        }

        const addressDiff = new Map<string, number>();
        let totalDiff = 0;
        for (const e of entries) {
            const [addr, diffStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
            totalDiff += diff;
        }
        if (totalDiff <= 0) return this.fallback();

        const feePercent = this.feePercent;
        const rewardForMiners = Math.floor(((100 - feePercent) / 100) * blockRewardSats);

        // Include pending balances from prior rounds.
        const pendingEntities = await this.balanceRepo.find({ where: { groupId } });
        const pendingMap = new Map<string, number>();
        for (const p of pendingEntities) pendingMap.set(p.address, p.pendingSats);

        const minerShares: { address: string; sats: number; percent: number }[] = [];
        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const baseSats = Math.floor(ratio * rewardForMiners);
            const totalSats = baseSats + (pendingMap.get(addr) ?? 0);
            minerShares.push({
                address: addr,
                sats: totalSats,
                percent: (totalSats / blockRewardSats) * 100,
            });
        }
        // Pending-only entries (members with pending ≥ dust but no shares this round).
        for (const [addr, pending] of pendingMap) {
            if (!addressDiff.has(addr) && pending >= DUST_LIMIT_SATS) {
                minerShares.push({
                    address: addr,
                    sats: pending,
                    percent: (pending / blockRewardSats) * 100,
                });
            }
        }

        const eligible = minerShares
            .filter(m => m.sats >= DUST_LIMIT_SATS)
            .sort((a, b) => b.sats - a.sats);

        const feeOutputCount = this.feeAddress ? 1 : 0;
        const maxMinerOutputs = Math.floor(
            (this.coinbaseWeightBudget - COINBASE_BASE_WEIGHT - (feeOutputCount + 1) * COINBASE_OUTPUT_WEIGHT)
            / COINBASE_OUTPUT_WEIGHT,
        );

        const trimmed = eligible.length > maxMinerOutputs && maxMinerOutputs > 0
            ? eligible.slice(0, maxMinerOutputs)
            : eligible;
        if (trimmed.length < eligible.length) {
            console.warn(`[GroupSolo] Group ${groupId}: trimmed ${eligible.length - trimmed.length} smallest outputs to pending`);
        }

        const payouts: GroupSoloPayoutEntry[] = trimmed.map(m => ({ address: m.address, percent: m.percent }));
        let total = trimmed.reduce((sum, m) => sum + m.percent, 0);

        if (this.feeAddress) {
            payouts.unshift({ address: this.feeAddress, percent: feePercent });
            total += feePercent;
        }

        // Sweep remainder into fee (or last miner if no fee address).
        if (payouts.length > 0 && total < 100) {
            const remainder = 100 - total;
            if (this.feeAddress) {
                payouts[0].percent += remainder;
            } else {
                payouts[payouts.length - 1].percent += remainder;
            }
        }

        const result = payouts.length > 0 ? payouts : this.fallback();
        this.snapshots.set(groupId, { distribution: result, blockRewardSats });
        return result;
    }

    private fallback(): GroupSoloPayoutEntry[] {
        if (this.feeAddress) return [{ address: this.feeAddress, percent: 100 }];
        return [];
    }

    // ── Block Found ──────────────────────────────────────────────

    /**
     * Called when a block is found by a group-solo miner. Uses the coinbase snapshot
     * for bookkeeping, credits addresses trimmed from the coinbase to pending, and
     * resets the round (deletes all three Redis keys for this group).
     */
    async onBlockFound(blockHeight: number, blockRewardSats: number, finderAddress: string): Promise<void> {
        if (!this.isEnabled()) return;
        const entry = this.groupService.getGroupForAddress(finderAddress);
        if (!entry) return;
        const groupId = entry.groupId;

        if (this.blockFoundLocks.has(groupId)) {
            console.warn(`[GroupSolo] Block ${blockHeight} for group ${groupId} — already processing`);
            return;
        }
        this.blockFoundLocks.add(groupId);

        try {
            console.log(`[GroupSolo] Block ${blockHeight} found by group ${groupId} (finder=${finderAddress})`);

            const snapshot = this.snapshots.get(groupId);
            if (!snapshot || snapshot.distribution.length === 0) {
                console.warn(`[GroupSolo] No snapshot for group ${groupId} — using window recalculation fallback`);
                await this.onBlockFoundFromWindow(groupId, blockHeight, blockRewardSats);
                return;
            }
            this.snapshots.delete(groupId);
            const reward = snapshot.blockRewardSats;

            // Miners in the snapshot get paid via coinbase; clear any prior pending.
            for (const d of snapshot.distribution) {
                const paidSats = Math.floor((d.percent / 100) * reward);
                const isFee = d.address === this.feeAddress;
                if (!isFee) {
                    const existing = await this.balanceRepo.findOneBy({ address: d.address });
                    if (existing && existing.pendingSats > 0) {
                        existing.totalPaidSats += existing.pendingSats;
                        existing.pendingSats = 0;
                        await this.balanceRepo.save(existing);
                    }
                }
                await this.historyRepo.save(this.historyRepo.create({
                    groupId, blockHeight, address: d.address,
                    paidSats, percent: d.percent,
                    sharesInRound: 0, totalSharesInRound: 0,
                    inCoinbase: true,
                }));
            }

            // Members with shares this round who didn't make the coinbase → pending.
            const snapshotAddrs = new Set(snapshot.distribution.map(d => d.address));
            const keys = redisKeys(groupId);
            const entries = await this.redis.zRange(keys.shares, 0, -1);
            if (entries && entries.length > 0) {
                const addressDiff = new Map<string, number>();
                let totalDiff = 0;
                for (const e of entries) {
                    const [addr, diffStr] = e.split(':');
                    const diff = parseFloat(diffStr) || 0;
                    addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
                    totalDiff += diff;
                }
                const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * reward);
                for (const [addr, diff] of addressDiff) {
                    if (snapshotAddrs.has(addr)) continue;
                    const sats = Math.floor((diff / totalDiff) * rewardForMiners);
                    if (sats > 0) {
                        await this.addPending(groupId, addr, sats);
                        await this.historyRepo.save(this.historyRepo.create({
                            groupId, blockHeight, address: addr,
                            paidSats: sats,
                            percent: (diff / totalDiff) * (100 - this.feePercent),
                            sharesInRound: Math.round(diff),
                            totalSharesInRound: Math.round(totalDiff),
                            inCoinbase: false,
                        }));
                    }
                }
            }

            // PROP semantics: clear the round.
            await this.resetRound(groupId);
        } finally {
            this.blockFoundLocks.delete(groupId);
        }
    }

    /** Fallback when no snapshot is available (first block or race). */
    private async onBlockFoundFromWindow(groupId: string, blockHeight: number, blockRewardSats: number): Promise<void> {
        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        if (!entries || entries.length === 0) {
            await this.resetRound(groupId);
            return;
        }

        const addressDiff = new Map<string, number>();
        let totalDiff = 0;
        for (const e of entries) {
            const [addr, diffStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
            totalDiff += diff;
        }
        if (totalDiff <= 0) {
            await this.resetRound(groupId);
            return;
        }

        const rewardForMiners = Math.floor(((100 - this.feePercent) / 100) * blockRewardSats);

        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const sats = Math.floor(ratio * rewardForMiners);
            const existing = await this.balanceRepo.findOneBy({ address: addr });
            const pending = existing?.pendingSats ?? 0;
            const totalSats = sats + pending;
            const percent = ratio * (100 - this.feePercent);

            if (totalSats >= DUST_LIMIT_SATS) {
                if (existing && pending > 0) {
                    existing.totalPaidSats += pending;
                    existing.pendingSats = 0;
                    await this.balanceRepo.save(existing);
                }
                await this.historyRepo.save(this.historyRepo.create({
                    groupId, blockHeight, address: addr,
                    paidSats: totalSats, percent,
                    sharesInRound: Math.round(diff),
                    totalSharesInRound: Math.round(totalDiff),
                    inCoinbase: true,
                }));
            } else {
                if (sats > 0) {
                    await this.addPending(groupId, addr, sats);
                    await this.historyRepo.save(this.historyRepo.create({
                        groupId, blockHeight, address: addr,
                        paidSats: sats, percent,
                        sharesInRound: Math.round(diff),
                        totalSharesInRound: Math.round(totalDiff),
                        inCoinbase: false,
                    }));
                }
            }
        }

        if (this.feeAddress) {
            const feeSats = blockRewardSats - rewardForMiners;
            await this.historyRepo.save(this.historyRepo.create({
                groupId, blockHeight, address: this.feeAddress,
                paidSats: feeSats, percent: this.feePercent,
                sharesInRound: 0, totalSharesInRound: 0,
                inCoinbase: true,
            }));
        }

        await this.resetRound(groupId);
    }

    private async addPending(groupId: string, address: string, sats: number): Promise<void> {
        const existing = await this.balanceRepo.findOneBy({ address });
        if (existing) {
            existing.pendingSats += sats;
            await this.balanceRepo.save(existing);
        } else {
            await this.balanceRepo.save(this.balanceRepo.create({
                address, groupId, pendingSats: sats, totalPaidSats: 0,
            }));
        }
    }

    private async resetRound(groupId: string): Promise<void> {
        const keys = redisKeys(groupId);
        await this.redis.del(keys.shares);
        await this.redis.del(keys.counter);
        await this.redis.del(keys.total);
    }

    // ── Stats (for API) ──────────────────────────────────────────

    async getRoundStats(groupId: string): Promise<{
        totalDifficulty: number;
        shareCount: number;
        perAddress: { address: string; difficulty: number; percent: number }[];
    }> {
        if (!this.isEnabled()) {
            return { totalDifficulty: 0, shareCount: 0, perAddress: [] };
        }
        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        const addressDiff = new Map<string, number>();
        let totalDiff = 0;
        for (const e of (entries ?? [])) {
            const [addr, diffStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            addressDiff.set(addr, (addressDiff.get(addr) ?? 0) + diff);
            totalDiff += diff;
        }
        const perAddress = Array.from(addressDiff.entries())
            .map(([address, difficulty]) => ({
                address,
                difficulty,
                percent: totalDiff > 0 ? (difficulty / totalDiff) * 100 : 0,
            }))
            .sort((a, b) => b.percent - a.percent);

        return {
            totalDifficulty: totalDiff,
            shareCount: (entries ?? []).length,
            perAddress,
        };
    }

    async getBlockHistory(groupId: string, limit = 100): Promise<PplnsGroupBlockHistoryEntity[]> {
        return this.historyRepo.find({
            where: { groupId },
            order: { createdAt: 'DESC' },
            take: Math.min(Math.max(limit, 1), 500),
        });
    }
}
