import { Injectable, Inject, OnModuleInit, forwardRef } from '@nestjs/common';
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

// Coinbase structural weight constants, calibrated against the real builder
// in src/models/MiningJob.ts (createCoinbaseTransaction).
//
// BASE: version + input(coinbase prev-out, script, sequence) + output-count
// byte + locktime + witness-reserved-value. ~420 WU on the wire; 320 is a
// conservative-low estimate that leaves small headroom.
//
// OUTPUT: we size for P2TR (34-byte scriptPubKey → 43 bytes serialized →
// 172 WU) rather than P2WPKH (22 bytes → 124 WU) so a group made entirely
// of Taproot miners doesn't overshoot the budget.
//
// WITNESS_OUTPUT: the segwit-commitment OP_RETURN added by MiningJob at
// line 69 is ~38 bytes script → ~47 bytes serialized → ~188 WU. Reserving
// 124 for it (as earlier code did by treating it as a regular output)
// underestimated by ~64 WU. Reserve the real figure.
const COINBASE_BASE_WEIGHT = 320;
const COINBASE_OUTPUT_WEIGHT = 172;
const COINBASE_WITNESS_COMMITMENT_WEIGHT = 188;

function redisKeys(groupId: string) {
    return {
        shares: `groupsolo:${groupId}:shares`,
        counter: `groupsolo:${groupId}:counter`,
        total: `groupsolo:${groupId}:total`,
        // Per-address rejected shares for the current round (diff-1 weighted).
        // No separate count key — the share value already captures real work.
        rejectedShares: `groupsolo:${groupId}:rejected-shares`,
        // Per-address last-accepted-share epoch-ms. Persists across rounds
        // (NOT cleared on block-found) so the admin-kick inactivity gate
        // can look back weeks.
        lastShareAt: `groupsolo:${groupId}:last-share-at`,
        // Coinbase-time distribution snapshot, JSON-encoded. Created by
        // getPayoutDistribution, consumed by onBlockFound. Persists across
        // pool restart (AOF) so a crash between job-send and block-found
        // doesn't cause payouts to drift from the on-chain coinbase.
        snapshot: `groupsolo:${groupId}:snapshot`,
    };
}

const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block+restart delay.

interface StoredSnapshot {
    distribution: GroupSoloPayoutEntry[];
    blockRewardSats: number;
    consideredAddresses: string[];
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

    /**
     * Coinbase snapshot per group, persisted in Redis (see redisKeys().snapshot).
     * `distribution` = what goes into the coinbase; `consideredAddresses` = every
     * address that was in the Redis window at the moment the snapshot was built
     * (including sub-dust miners filtered out). This lets onBlockFound distinguish
     * two classes of "not in coinbase" miners:
     *   - sub-dust: was in the window at snapshot time → credit to pending so they accumulate
     *   - late arriver: submitted after snapshot was built → don't credit (would double-count)
     *
     * Persistence in Redis (not an in-memory Map) is critical: a pool restart
     * between the miner receiving the coinbase template and the block landing
     * would otherwise lose the snapshot, forcing onBlockFound onto the
     * current-window fallback whose distribution can differ from the on-chain
     * coinbase. 1h TTL covers worst-case block-find + restart windows; long
     * enough that a normal-case outage is fine, short enough that stale
     * snapshots don't pile up forever.
     */

    /** Per-group block-found reentrancy guard. */
    private blockFoundLocks = new Set<string>();

    constructor(
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @InjectRepository(PplnsGroupBlockHistoryEntity)
        private readonly historyRepo: Repository<PplnsGroupBlockHistoryEntity>,
        @InjectRepository(PplnsGroupBalanceEntity)
        private readonly balanceRepo: Repository<PplnsGroupBalanceEntity>,
        @Inject(forwardRef(() => GroupService))
        private readonly groupService: GroupService,
    ) {
        this.feeAddress = this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(this.configService.get('PPLNS_FEE_PERCENT') ?? '2');
        this.coinbaseWeightBudget = parseInt(
            this.configService.get('PPLNS_COINBASE_WEIGHT_BUDGET') ?? DEFAULT_COINBASE_WEIGHT_BUDGET.toString(),
            10,
        ) || DEFAULT_COINBASE_WEIGHT_BUDGET;
        // Group-solo is always enabled if the service is loaded — routing is
        // address-driven via the GroupService's address→group cache.
        this.enabled = true;
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
        const now = Date.now();
        const counter = await this.redis.incr(keys.counter);
        const payload = `${address}:${difficulty}:${now}`;
        await this.redis.zAdd(keys.shares, { score: counter, value: payload });
        await this.redis.incrByFloat(keys.total, difficulty);
        await this.redis.hSet(keys.lastShareAt, address, String(now));
        return true;
    }

    /**
     * Record a rejected share. Aggregated per-address into a single hash so
     * the distribution endpoint can show rejected stats per member. Value
     * is diff-1 weighted (real work units). Reset with the rest of the
     * round on block-found.
     */
    async recordReject(address: string, shares: number): Promise<boolean> {
        if (!this.isEnabled()) return false;
        const entry = this.groupService.getGroupForAddress(address);
        if (!entry || !entry.active) return false;

        const keys = redisKeys(entry.groupId);
        await this.redis.hIncrByFloat(keys.rejectedShares, address, shares);
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

        // Pending balances are IOUs to members from prior sub-dust / trim
        // rounds (and, with group-solo, from kick-redistribute). They have
        // to be settled out of THIS block's miner cut — not on top of it —
        // otherwise the sum of coinbase outputs exceeds blockRewardSats
        // and Bitcoin Core rejects the block with bad-cb-amount. Subtract
        // the total pending from rewardForMiners before distributing by
        // share ratio; each miner still gets their own pending credited
        // on top of their reduced base-share.
        const totalPending = Array.from(pendingMap.values()).reduce((s, v) => s + v, 0);
        const effectiveMinerReward = Math.max(0, rewardForMiners - totalPending);

        const minerShares: { address: string; sats: number; percent: number }[] = [];
        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const baseSats = Math.floor(ratio * effectiveMinerReward);
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
        // Budget layout: BASE + OP_RETURN (witness commitment) + feeOutput?
        //   → rest splits into miner outputs of COINBASE_OUTPUT_WEIGHT each.
        // The OP_RETURN is always present (segwit commitment), the fee
        // output only when feeAddress is configured.
        const maxMinerOutputs = Math.floor(
            (this.coinbaseWeightBudget
                - COINBASE_BASE_WEIGHT
                - COINBASE_WITNESS_COMMITMENT_WEIGHT
                - feeOutputCount * COINBASE_OUTPUT_WEIGHT)
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
            // Only emit the fee output if the resulting on-chain amount
            // clears dust. Below ~546 sats (depends on output type) the
            // output would be rejected by Bitcoin Core policy and the
            // whole block invalidated. In practice on mainnet at the
            // current 3.125 BTC subsidy this never triggers for any
            // feePercent > 0, but a regtest / low-subsidy / configured-
            // down scenario can hit it. When dust, fold the fee silently
            // into the miner pool so the block is still valid — the pool
            // operator loses that block's fee, which is the right
            // tradeoff over a bricked block.
            const feeSats = Math.floor((feePercent / 100) * blockRewardSats);
            if (feeSats >= DUST_LIMIT_SATS) {
                payouts.unshift({ address: this.feeAddress, percent: feePercent });
                total += feePercent;
            } else {
                console.warn(`[GroupSolo] Fee output ${feeSats} sats < dust — omitting fee, miners keep 100% this block`);
            }
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
        // Record every address that contributed work at snapshot-build time, including
        // sub-dust miners that got filtered out of the coinbase. See `snapshots` field
        // doc for why this distinction matters.
        const consideredAddresses = new Set<string>(addressDiff.keys());
        for (const addr of pendingMap.keys()) consideredAddresses.add(addr);
        await this.writeSnapshot(groupId, {
            distribution: result,
            blockRewardSats,
            consideredAddresses: Array.from(consideredAddresses),
        });
        return result;
    }

    private async writeSnapshot(groupId: string, snapshot: StoredSnapshot): Promise<void> {
        const keys = redisKeys(groupId);
        try {
            await this.redis.set(keys.snapshot, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL_SECONDS });
        } catch {
            // Some ioredis / node-redis variants don't accept the options
            // object — fall back to set + expire.
            await this.redis.set(keys.snapshot, JSON.stringify(snapshot));
            if (typeof this.redis.expire === 'function') {
                await this.redis.expire(keys.snapshot, SNAPSHOT_TTL_SECONDS);
            }
        }
    }

    private async readSnapshot(groupId: string): Promise<{
        distribution: GroupSoloPayoutEntry[];
        blockRewardSats: number;
        consideredAddresses: Set<string>;
    } | null> {
        const keys = redisKeys(groupId);
        const raw = await this.redis.get(keys.snapshot);
        if (!raw) return null;
        try {
            const parsed: StoredSnapshot = JSON.parse(raw);
            return {
                distribution: parsed.distribution,
                blockRewardSats: parsed.blockRewardSats,
                consideredAddresses: new Set(parsed.consideredAddresses),
            };
        } catch {
            return null;
        }
    }

    private async deleteSnapshot(groupId: string): Promise<void> {
        const keys = redisKeys(groupId);
        await this.redis.del(keys.snapshot);
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

            const snapshot = await this.readSnapshot(groupId);
            if (!snapshot || snapshot.distribution.length === 0) {
                console.warn(`[GroupSolo] No snapshot for group ${groupId} — using window recalculation fallback`);
                await this.onBlockFoundFromWindow(groupId, blockHeight, blockRewardSats);
                return;
            }
            await this.deleteSnapshot(groupId);
            const reward = snapshot.blockRewardSats;

            // Miners in the snapshot get paid via coinbase; clear any prior pending.
            for (const d of snapshot.distribution) {
                const paidSats = Math.floor((d.percent / 100) * reward);
                const isFee = d.address === this.feeAddress;
                if (!isFee) {
                    const existing = await this.balanceRepo.findOneBy({ address: d.address, groupId });
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

            // For each window address not in snapshot.distribution, determine whether
            // it was considered at snapshot-build time:
            //   - YES → sub-dust miner (filtered by dust or weight-budget): credit to
            //     pending so it accumulates for future coinbase inclusion.
            //   - NO  → late arriver (share landed in Redis after snapshot was built):
            //     under PROP rules this work is lost for the current block. Credit
            //     would double-count because the snapshot already claims 100% of the
            //     miner cut in the on-chain coinbase.
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
                    const wasConsidered = snapshot.consideredAddresses.has(addr);
                    if (wasConsidered) {
                        // Sub-dust or weight-trimmed — credit to pending proportional to
                        // their share of the (original) snapshot-time window. Since we
                        // don't store the snapshot-time totalDiff, we use current-window
                        // ratio as an approximation; on mainnet the window is stable
                        // enough that this is accurate to within rounding.
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
                    } else {
                        // Late arriver — audit row only, no payout.
                        await this.historyRepo.save(this.historyRepo.create({
                            groupId, blockHeight, address: addr,
                            paidSats: 0,
                            percent: 0,
                            sharesInRound: Math.round(diff),
                            totalSharesInRound: Math.round(totalDiff),
                            inCoinbase: false,
                        }));
                        console.log(`[GroupSolo]   ${addr}: ${diff.toFixed(2)} shares in round but not in coinbase snapshot (late arrival, PROP rules)`);
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
        // Same pending-settlement rule as getPayoutDistribution: pending
        // comes out of the miner cut, not on top. Otherwise total outputs
        // exceed blockReward and Core rejects with bad-cb-amount.
        const pendingEntities = await this.balanceRepo.find({ where: { groupId } });
        const totalPending = pendingEntities.reduce((s, p) => s + (p.pendingSats ?? 0), 0);
        const effectiveMinerReward = Math.max(0, rewardForMiners - totalPending);

        for (const [addr, diff] of addressDiff) {
            const ratio = diff / totalDiff;
            const sats = Math.floor(ratio * effectiveMinerReward);
            const existing = await this.balanceRepo.findOneBy({ address: addr, groupId });
            const pending = existing?.pendingSats ?? 0;
            const totalSats = sats + pending;
            const percent = (totalSats / blockRewardSats) * 100;

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
            if (feeSats >= DUST_LIMIT_SATS) {
                await this.historyRepo.save(this.historyRepo.create({
                    groupId, blockHeight, address: this.feeAddress,
                    paidSats: feeSats, percent: this.feePercent,
                    sharesInRound: 0, totalSharesInRound: 0,
                    inCoinbase: true,
                }));
            } else {
                // Dust — fee was omitted from the coinbase to keep the
                // block valid. See dust-gate in getPayoutDistribution.
                console.warn(`[GroupSolo] Fallback: fee output ${feeSats} sats < dust — not recording fee history row`);
            }
        }

        await this.resetRound(groupId);
    }

    private async addPending(groupId: string, address: string, sats: number): Promise<void> {
        const existing = await this.balanceRepo.findOneBy({ address, groupId });
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
        await this.redis.del(keys.rejectedShares);
        // lastShareAt is intentionally NOT cleared on round reset — it
        // survives across blocks so the inactivity gate measures actual
        // time since last work, not time since last round start.
    }

    // ── Member lifecycle (called by GroupService) ──────────────

    /**
     * Milliseconds-since-epoch of the most recent accepted share from
     * `address` in `groupId`, or null if no share has ever been recorded
     * (member was invited but never mined to this group).
     */
    async getMemberLastActive(groupId: string, address: string): Promise<number | null> {
        if (!this.isEnabled()) return null;
        const keys = redisKeys(groupId);
        const raw = await this.redis.hGet(keys.lastShareAt, address);
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Remove all round-state for a single member in a group: their shares
     * in the current Redis window, their rejected counter, their pending
     * balance row, and their last-share timestamp. Called by GroupService
     * before deleting the member row during an admin kick.
     *
     * Effect on the remaining members:
     *   - Shares in the current Redis round: the kicked miner's entries
     *     are removed and `total` is decremented by their diff. Others'
     *     share of the round grows proportionally on the next block.
     *   - Accumulated pending balance (sub-dust from prior rounds): split
     *     equally among `remainingAddresses` and credited to each of
     *     their pplns_group_balance rows. The kicked miner's row is then
     *     deleted. Integer-division remainder (< N sats) is dropped.
     *
     * `remainingAddresses` is passed in by the caller (GroupService, which
     * already read the member list for other reasons) so we don't need a
     * second query inside this service. An empty list triggers forfeit —
     * the only case where the group has literally no one left is on
     * dissolveInternal, which uses removeGroupState instead anyway.
     */
    async removeMemberState(groupId: string, address: string, remainingAddresses: string[] = []): Promise<void> {
        // Read the kicked member's pending balance before we clear anything,
        // so we can redistribute it on the way out.
        const existing = await this.balanceRepo.findOneBy({ address, groupId });
        const pendingToRedistribute = existing?.pendingSats ?? 0;

        if (this.isEnabled()) {
            const keys = redisKeys(groupId);
            const entries = await this.redis.zRange(keys.shares, 0, -1);
            let removedDiff = 0;
            for (const e of (entries ?? [])) {
                const [addr, diffStr] = e.split(':');
                if (addr === address) {
                    await this.redis.zRem(keys.shares, e);
                    removedDiff += parseFloat(diffStr) || 0;
                }
            }
            if (removedDiff > 0) {
                await this.redis.incrByFloat(keys.total, -removedDiff);
            }
            await this.redis.hDel(keys.rejectedShares, address);
            await this.redis.hDel(keys.lastShareAt, address);
        }

        await this.balanceRepo.delete({ address, groupId });

        if (pendingToRedistribute > 0 && remainingAddresses.length > 0) {
            const perMember = Math.floor(pendingToRedistribute / remainingAddresses.length);
            if (perMember > 0) {
                for (const recipient of remainingAddresses) {
                    await this.addPending(groupId, recipient, perMember);
                }
                console.log(`[GroupSolo] Kicked ${address} from ${groupId}: redistributed ${pendingToRedistribute} sats pending to ${remainingAddresses.length} member(s) (${perMember} each)`);
            }
        }
    }

    /**
     * Remove all round-state for every member of a group. Called by
     * GroupService.dissolveInternal so no orphan keys/rows survive the
     * dissolve event.
     */
    async removeGroupState(groupId: string): Promise<void> {
        if (this.isEnabled()) {
            await this.resetRound(groupId);
            const keys = redisKeys(groupId);
            await this.redis.del(keys.lastShareAt);
            await this.redis.del(keys.snapshot);
        }
        await this.balanceRepo.delete({ groupId });
        await this.historyRepo.delete({ groupId });
    }

    // ── Stats (for API) ──────────────────────────────────────────

    async getRoundStats(groupId: string): Promise<{
        totalShares: number;
        totalRejected: number;
        perAddress: {
            address: string;
            totalShares: number;
            percent: number;
            totalRejected: number;
        }[];
    }> {
        if (!this.isEnabled()) {
            return {
                totalShares: 0,
                totalRejected: 0,
                perAddress: [],
            };
        }
        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        const addressShares = new Map<string, number>();
        let totalShares = 0;
        // All values are diff-1 weighted (real work units), not raw share counts.
        for (const e of (entries ?? [])) {
            const [addr, sharesStr] = e.split(':');
            const shares = parseFloat(sharesStr) || 0;
            addressShares.set(addr, (addressShares.get(addr) ?? 0) + shares);
            totalShares += shares;
        }

        const rejectedSharesMap = (await this.redis.hGetAll(keys.rejectedShares)) ?? {};
        const addressRejected = new Map<string, number>();
        let totalRejected = 0;
        for (const [addr, v] of Object.entries(rejectedSharesMap)) {
            const r = parseFloat(v as string) || 0;
            addressRejected.set(addr, r);
            totalRejected += r;
        }

        const allAddresses = new Set<string>([
            ...addressShares.keys(),
            ...addressRejected.keys(),
        ]);
        const perAddress = Array.from(allAddresses).map((address) => {
            const shares = addressShares.get(address) ?? 0;
            return {
                address,
                totalShares: shares,
                percent: totalShares > 0 ? (shares / totalShares) * 100 : 0,
                totalRejected: addressRejected.get(address) ?? 0,
            };
        }).sort((a, b) => b.percent - a.percent);

        return {
            totalShares,
            totalRejected,
            perAddress,
        };
    }

    /**
     * Best single share submitted in the current round across all group
     * members — i.e. the highest diff-1-weighted share in the Redis window.
     * Returns the value plus the address that submitted it. Resets when
     * the round resets (block-found).
     */
    async getRoundBestDifficulty(groupId: string): Promise<{
        bestDifficulty: number;
        address: string | null;
        time: number | null;
    }> {
        if (!this.isEnabled()) {
            return { bestDifficulty: 0, address: null, time: null };
        }
        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        let bestDiff = 0;
        let bestAddr: string | null = null;
        let bestTime: number | null = null;
        for (const e of (entries ?? [])) {
            const [addr, diffStr, timeStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            if (diff > bestDiff) {
                bestDiff = diff;
                bestAddr = addr;
                bestTime = parseInt(timeStr, 10) || null;
            }
        }
        return { bestDifficulty: bestDiff, address: bestAddr, time: bestTime };
    }

    async getBlockHistory(groupId: string, limit = 100): Promise<PplnsGroupBlockHistoryEntity[]> {
        return this.historyRepo.find({
            where: { groupId },
            order: { createdAt: 'DESC' },
            take: Math.min(Math.max(limit, 1), 500),
        });
    }
}
