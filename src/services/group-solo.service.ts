import { Injectable, Inject, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { GroupService } from './group.service';
import {
    buildCoinbaseDistribution,
    DUST_LIMIT_SATS,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
    DEFAULT_MIN_PAYOUT_SATS,
} from './coinbase-distribution';

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

// Coinbase distribution math is shared with PPLNS via
// ./coinbase-distribution.ts — see its docblock for invariants. Constants
// (DUST_LIMIT_SATS, DEFAULT_COINBASE_WEIGHT_BUDGET) are re-imported from
// there so there's a single source of truth.

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
        //
        // With finder-bonus, every miner gets their own coinbase template
        // (their address as bonus recipient), so snapshots are keyed by
        // `${snapshotPrefix}:${finderAddress}`. snapshotPrefix is also used
        // as the SCAN match base for cleanup (resetRound, removeGroupState).
        snapshotPrefix: `groupsolo:${groupId}:snapshot`,
    };
}

function snapshotKeyFor(groupId: string, finderAddress: string | null | undefined): string {
    return `groupsolo:${groupId}:snapshot:${finderAddress ?? '__none__'}`;
}

const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block+restart delay.

interface StoredSnapshot {
    distribution: GroupSoloPayoutEntry[];
    blockRewardSats: number;
    consideredAddresses: string[];
    balanceAfter: Array<[string, number]>;
}

export interface GroupSoloPayoutEntry {
    address: string;
    percent: number;
    sats: number;
}

@Injectable()
export class GroupSoloService implements OnModuleInit {

    private redis: any = null;
    private enabled = false;
    private feeAddress: string;
    private feePercent: number;
    private readonly coinbaseWeightBudget: number;
    private readonly minPayoutSats: number;

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
        @InjectRepository(PplnsGroupEntity)
        private readonly groupRepo: Repository<PplnsGroupEntity>,
        @Inject(forwardRef(() => GroupService))
        private readonly groupService: GroupService,
    ) {
        this.feeAddress = this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(this.configService.get('PPLNS_FEE_PERCENT') ?? '2');
        this.coinbaseWeightBudget = parseInt(
            this.configService.get('PPLNS_COINBASE_WEIGHT_BUDGET') ?? DEFAULT_COINBASE_WEIGHT_BUDGET.toString(),
            10,
        ) || DEFAULT_COINBASE_WEIGHT_BUDGET;
        // Operational minimum payout — same env var as the PPLNS engine
        // so groups inherit the pool's dust-vs-bloat policy. Clamped to
        // the Bitcoin Core dust policy floor (DUST_LIMIT_SATS = 546).
        const rawMinPayout = parseInt(
            this.configService.get('PPLNS_MIN_PAYOUT_SATS') ?? DEFAULT_MIN_PAYOUT_SATS.toString(),
            10,
        );
        this.minPayoutSats = Math.max(
            DUST_LIMIT_SATS,
            Number.isFinite(rawMinPayout) && rawMinPayout > 0 ? rawMinPayout : DEFAULT_MIN_PAYOUT_SATS,
        );
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

    /**
     * Effective minimum-payout floor for any on-chain output the engine
     * emits (after the DUST_LIMIT_SATS clamp). GroupService reads this
     * to validate `finderBonusSats` at PATCH time — a bonus below this
     * threshold would silently be dropped by the coinbase-distribution
     * math (`bonusEmitted = cappedBonusSats >= minPayout`), so the API
     * rejects it instead of letting the admin configure a no-op.
     */
    getMinPayoutSats(): number {
        return this.minPayoutSats;
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

        // Persist last-accepted-share timestamp on the balance row so the
        // dust-sweep cron can tell dormant dust from active dust. No-op
        // when the balance row doesn't exist yet — the first pending
        // credit in onBlockFound will initialize it.
        this.balanceRepo.update({ address, groupId: entry.groupId }, {
            lastAcceptedShareAt: new Date(now),
        }).catch(err => {
            console.warn(`[GroupSolo] touchLastAcceptedShareAt failed for ${address} in ${entry.groupId}:`, (err as Error).message);
        });

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
     *
     * Per-miner coinbase: when `finderAddress` is provided AND the group's
     * `finderBonusSats > 0`, the resulting distribution emits a dedicated
     * bonus output to `finderAddress`, financed proportionally by reducing
     * every active miner's share (including the finder's own). The finder
     * gets `bonus + their_proportional_share_of_(reward - bonus)`.
     *
     * Each miner's stratum session calls this with their own address, so
     * each miner's coinbase template names them as the finder. The snapshot
     * is keyed per-finderAddress so onBlockFound can reconstruct the exact
     * on-chain split for whichever miner actually finds the block.
     *
     * `finderAddress` may be omitted (e.g. unauthorized session, JDP path
     * which is excluded for Group-Solo). In that case no bonus output is
     * emitted and the snapshot is stored under the legacy "__none__" key.
     */
    async getPayoutDistribution(
        groupId: string,
        blockRewardSats: number,
        finderAddress?: string,
    ): Promise<GroupSoloPayoutEntry[]> {
        if (!this.isEnabled()) return this.fallback(blockRewardSats);

        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        if (!entries || entries.length === 0) {
            return this.fallback(blockRewardSats);
        }

        const addressShares = new Map<string, number>();
        for (const e of entries) {
            const [addr, diffStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            addressShares.set(addr, (addressShares.get(addr) ?? 0) + diff);
        }

        const balanceEntities = await this.balanceRepo.find({ where: { groupId } });
        const balances = new Map<string, number>();
        for (const p of balanceEntities) balances.set(p.address, p.pendingSats);

        // Read finder-bonus from the live group config. Null/0 disables the
        // bonus path entirely; a positive value combined with `finderAddress`
        // activates the per-miner bonus output.
        const group = await this.groupRepo.findOneBy({ id: groupId });
        const finderBonusSats = (group?.finderBonusSats ?? 0) > 0
            ? group!.finderBonusSats!
            : 0;

        const result = buildCoinbaseDistribution({
            addressShares,
            balances,
            blockRewardSats,
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
            minPayoutSats: this.minPayoutSats,
            logLabel: `[GroupSolo ${groupId}]`,
            // Group-Solo stays on the unsigned-pending ledger model: pendingSats
            // is always ≥ 0. This means Phase 5a trim redistribution and Phase
            // 5b floor-rounding residuum go to the fee output instead of
            // creating matching debits on active members. Cost: ~1–10 sats per
            // block donated to the fee (trivial relative to the fee percent
            // the pool already collects). Benefit: the legacy single-sided
            // dust sweep keeps working, member-kick redistribution stays
            // sane, and there's no second signed-ledger maintenance machinery
            // to build just for group-solo.
            suppressMatchingDebits: true,
            finderBonusSats,
            finderAddress,
        });

        const payouts: GroupSoloPayoutEntry[] = result.payouts.length > 0
            ? result.payouts.map(p => ({ address: p.address, percent: p.percent, sats: p.sats }))
            : this.fallback(blockRewardSats);

        await this.writeSnapshot(groupId, finderAddress, {
            distribution: payouts,
            blockRewardSats,
            consideredAddresses: Array.from(result.consideredAddresses),
            balanceAfter: Array.from(result.balanceAfter.entries()),
        });
        return payouts;
    }

    private async writeSnapshot(
        groupId: string,
        finderAddress: string | undefined,
        snapshot: StoredSnapshot,
    ): Promise<void> {
        const key = snapshotKeyFor(groupId, finderAddress);
        try {
            await this.redis.set(key, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL_SECONDS });
        } catch {
            // Some ioredis / node-redis variants don't accept the options
            // object — fall back to set + expire.
            await this.redis.set(key, JSON.stringify(snapshot));
            if (typeof this.redis.expire === 'function') {
                await this.redis.expire(key, SNAPSHOT_TTL_SECONDS);
            }
        }
    }

    private async readSnapshot(
        groupId: string,
        finderAddress: string | undefined,
    ): Promise<{
        distribution: GroupSoloPayoutEntry[];
        blockRewardSats: number;
        consideredAddresses: Set<string>;
        balanceAfter: Map<string, number>;
    } | null> {
        const key = snapshotKeyFor(groupId, finderAddress);
        const raw = await this.redis.get(key);
        if (!raw) return null;
        try {
            const parsed: StoredSnapshot = JSON.parse(raw);
            return {
                distribution: parsed.distribution.map(d => ({
                    address: d.address,
                    percent: d.percent,
                    sats: d.sats ?? Math.floor((d.percent / 100) * parsed.blockRewardSats),
                })),
                blockRewardSats: parsed.blockRewardSats,
                consideredAddresses: new Set(parsed.consideredAddresses ?? []),
                balanceAfter: new Map(parsed.balanceAfter ?? []),
            };
        } catch {
            return null;
        }
    }

    /**
     * Delete every per-finder snapshot for a group. Called by
     * onBlockFound after a block is processed (round reset → all
     * other miners' snapshots are stale) and by removeGroupState
     * during dissolve. Uses SCAN to avoid unbounded KEYS lookups.
     */
    private async deleteAllSnapshots(groupId: string): Promise<void> {
        const keys = redisKeys(groupId);
        const pattern = `${keys.snapshotPrefix}:*`;
        try {
            let cursor = 0;
            do {
                const result = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
                cursor = result.cursor;
                if (result.keys && result.keys.length > 0) {
                    await this.redis.del(result.keys);
                }
            } while (cursor !== 0);
        } catch (err) {
            console.warn(`[GroupSolo] deleteAllSnapshots(${groupId}) failed:`, (err as Error).message);
        }
        // Also clear the legacy "single snapshot per group" key so
        // pools upgrading from the pre-finder-bonus codebase don't
        // leave dead state behind. No-op if the key doesn't exist.
        await this.redis.del(keys.snapshotPrefix);
    }

    /**
     * "No miners in window / service disabled" fallback shape — emits the
     * fee address as a single 100 % output, or an empty array if no fee
     * address is configured. Mirrors PplnsService.fallbackDistribution; the
     * required `blockRewardSats` parameter prevents the silent-zero-sats
     * footgun the prior optional signature had (a callsite that forgot to
     * pass the reward would emit a 0-sat coinbase output that callers'
     * `length > 0` checks happily accepted).
     */
    private fallback(blockRewardSats: number): GroupSoloPayoutEntry[] {
        if (this.feeAddress) {
            return [{
                address: this.feeAddress,
                percent: 100,
                sats: blockRewardSats,
            }];
        }
        return [];
    }

    // ── Block Found ──────────────────────────────────────────────

    /**
     * Called when a block is found by a group-solo miner. Uses the coinbase snapshot
     * for bookkeeping, credits addresses trimmed from the coinbase to pending, and
     * resets the round (deletes all three Redis keys for this group).
     *
     * Idempotency: every history-write + balance-update happens inside one
     * Postgres transaction, guarded by a pre-check on
     * pplns_group_block_history.(groupId, blockHeight). A crash mid-TX rolls
     * back everything, so replay after restart re-runs from scratch. The
     * unique index on (groupId, blockHeight, address) is the defense-in-
     * depth layer that catches pathological races (clustered pool).
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
            // Idempotency pre-check.
            const alreadyProcessed = await this.historyRepo.findOneBy({ groupId, blockHeight });
            if (alreadyProcessed) {
                console.log(`[GroupSolo] Block ${blockHeight} for group ${groupId} already processed — skipping replay`);
                return;
            }

            console.log(`[GroupSolo] Block ${blockHeight} found by group ${groupId} (finder=${finderAddress})`);

            // Read the snapshot built for THIS specific finder. With per-miner
            // coinbases (finder-bonus feature), every miner has their own
            // snapshot keyed by finderAddress; only the finder's snapshot
            // matches the on-chain coinbase, so that's the one we use for
            // accounting. Falls back to the legacy "no finder" key if
            // present (graceful upgrade from pre-finder-bonus snapshots).
            let snapshot = await this.readSnapshot(groupId, finderAddress);
            if (!snapshot || snapshot.distribution.length === 0) {
                snapshot = await this.readSnapshot(groupId, undefined);
            }
            if (!snapshot || snapshot.distribution.length === 0) {
                console.warn(`[GroupSolo] No snapshot for group ${groupId} (finder=${finderAddress}) — using window recalculation fallback`);
                await this.onBlockFoundFromWindow(groupId, blockHeight, blockRewardSats, finderAddress);
                return;
            }

            // Same defensive reward-mismatch check as PPLNS: if the snapshot
            // was built for a job whose coinbasevalue differs from the block's
            // real reward (concurrent jobs with mempool churn between them),
            // the stored distribution is for the wrong job. Fall back to the
            // window recalc path and drop the stale snapshot so it can't
            // resurface on the next block-found.
            if (snapshot.blockRewardSats !== blockRewardSats) {
                console.warn(
                    `[GroupSolo] Snapshot blockReward ${snapshot.blockRewardSats} != block's `
                    + `${blockRewardSats} for group ${groupId} — falling back to window recalc`,
                );
                await this.deleteAllSnapshots(groupId);
                await this.onBlockFoundFromWindow(groupId, blockHeight, blockRewardSats, finderAddress);
                return;
            }

            // Read the live window for diffByAddr / late-arriver tracking.
            const keys = redisKeys(groupId);
            const windowEntries = await this.redis.zRange(keys.shares, 0, -1);
            const windowAddrs = new Set<string>();
            let totalDiffRound = 0;
            const diffByAddr = new Map<string, number>();
            if (windowEntries && windowEntries.length > 0) {
                for (const e of windowEntries) {
                    const [addr, diffStr] = e.split(':');
                    const diff = parseFloat(diffStr) || 0;
                    windowAddrs.add(addr);
                    diffByAddr.set(addr, (diffByAddr.get(addr) ?? 0) + diff);
                    totalDiffRound += diff;
                }
            }

            const ok = await this.applyDistributionTx({
                groupId,
                blockHeight,
                distribution: snapshot.distribution,
                balanceAfter: snapshot.balanceAfter,
                consideredAddresses: snapshot.consideredAddresses,
                diffByAddr,
                totalDiffRound,
                windowAddrs,
                label: 'snapshot',
            });
            if (!ok) return;

            // Snapshot(s) + round cleared only after the TX committed. Order
            // matters: clear the share window FIRST, snapshots SECOND. If a
            // concurrent stratum session calls getPayoutDistribution between
            // the two Redis ops, an empty share window triggers the early-
            // exit fallback path which does NOT write a snapshot — so no
            // stale snapshot can survive into the next round. The reverse
            // order had a small race window where a new snapshot built from
            // soon-to-be-cleared shares could outlive resetRound and trip
            // the next block's mismatch guard.
            await this.resetRound(groupId);
            await this.deleteAllSnapshots(groupId);
        } finally {
            this.blockFoundLocks.delete(groupId);
        }
    }

    /**
     * Recompute fallback when no snapshot is available, or when the
     * snapshot's blockReward disagrees with the block's actual reward.
     *
     * Reads the current Redis window + balances, runs the SAME
     * `buildCoinbaseDistribution` math as the snapshot path (incl. finder-
     * bonus + suppressMatchingDebits), then persists via the shared
     * `applyDistributionTx`. Late arrivers don't exist in this path by
     * construction — window-read and distribution-build happen back-to-back,
     * so `consideredAddresses` covers every windowed miner.
     *
     * **Caveat**: the on-chain coinbase was built earlier from the template's
     * snapshot. If shares arrived between template-send and block-find, this
     * recomputed distribution may diverge from on-chain. The reward-mismatch
     * guard in onBlockFound covers the most common drift cause; for the
     * remaining gap operators must reconcile against the explorer (loud
     * `CRITICAL RECOMPUTE` warning below carries the per-miner dump).
     */
    private async onBlockFoundFromWindow(
        groupId: string,
        blockHeight: number,
        blockRewardSats: number,
        finderAddress: string,
    ): Promise<void> {
        const keys = redisKeys(groupId);
        const entries = await this.redis.zRange(keys.shares, 0, -1);
        if (!entries || entries.length === 0) {
            await this.resetRound(groupId);
            return;
        }

        const addressShares = new Map<string, number>();
        const diffByAddr = new Map<string, number>();
        let totalDiffRound = 0;
        for (const e of entries) {
            const [addr, diffStr] = e.split(':');
            const diff = parseFloat(diffStr) || 0;
            addressShares.set(addr, (addressShares.get(addr) ?? 0) + diff);
            diffByAddr.set(addr, (diffByAddr.get(addr) ?? 0) + diff);
            totalDiffRound += diff;
        }
        if (totalDiffRound <= 0) {
            await this.resetRound(groupId);
            return;
        }

        const balanceEntities = await this.balanceRepo.find({ where: { groupId } });
        const balances = new Map<string, number>();
        for (const p of balanceEntities) balances.set(p.address, p.pendingSats);

        // Read finder-bonus from the live group config — same as the snapshot
        // path. Without this the fallback would silently emit a coinbase
        // shape different from on-chain when finder-bonus is enabled.
        const group = await this.groupRepo.findOneBy({ id: groupId });
        const finderBonusSats = (group?.finderBonusSats ?? 0) > 0
            ? group!.finderBonusSats!
            : 0;

        const result = buildCoinbaseDistribution({
            addressShares,
            balances,
            blockRewardSats,
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
            minPayoutSats: this.minPayoutSats,
            suppressMatchingDebits: true,
            finderBonusSats,
            finderAddress,
            logLabel: `[GroupSolo fallback ${blockHeight}]`,
        });

        if (result.payouts.length === 0) {
            // Degenerate edge: no fee configured AND no eligible miners.
            // Nothing to record; just clear the round so the next block
            // starts fresh.
            await this.resetRound(groupId);
            return;
        }

        // Loud operator warning: the ledger is about to be written from a
        // recomputed distribution that MAY disagree with the actual on-chain
        // coinbase if shares shifted between template-send and block-find.
        // Mirrors PPLNS' applyDistributionWithoutSnapshot warning so an
        // operator can manually reconcile against the block explorer.
        const onChainTotal = result.payouts.reduce((s, p) => s + p.sats, 0);
        console.warn(
            `[GroupSolo CRITICAL RECOMPUTE] Block ${blockHeight} group ${groupId} `
            + `applying RECOMPUTED distribution (no valid snapshot for finder ${finderAddress}). `
            + `⚠️ This MAY diverge from the actual on-chain coinbase if shares shifted `
            + `between template-send and block-find. Manually verify against the block `
            + `explorer before trusting payout history for this block.\n`
            + `  blockReward:     ${blockRewardSats} sats\n`
            + `  onChain total:   ${onChainTotal} sats across ${result.payouts.length} outputs\n`
            + `  window miners:   ${addressShares.size}\n`
            + `  open balances:   ${balances.size}\n`
            + `  finderBonus:     ${finderBonusSats} sats (config) → ${finderAddress}\n`
            + `  coinbase dump:   ${JSON.stringify(result.payouts.map(p => ({ a: p.address, s: p.sats })))}`,
        );

        const distribution: GroupSoloPayoutEntry[] = result.payouts.map(p => ({
            address: p.address, percent: p.percent, sats: p.sats,
        }));
        const ok = await this.applyDistributionTx({
            groupId,
            blockHeight,
            distribution,
            balanceAfter: result.balanceAfter,
            consideredAddresses: result.consideredAddresses,
            diffByAddr,
            totalDiffRound,
            // Window read and distribution build happen back-to-back here,
            // so by construction every windowed address was considered —
            // the late-arriver loop in applyDistributionTx is a no-op.
            windowAddrs: new Set(addressShares.keys()),
            label: 'fallback',
        });
        if (!ok) return;

        await this.resetRound(groupId);
    }

    /**
     * Apply a computed coinbase distribution to the database in one TX.
     * Shared between the snapshot path (onBlockFound) and the recompute
     * fallback (onBlockFoundFromWindow) so both paths produce identical
     * history rows + balance updates for the same input.
     *
     * Returns true if the TX committed; false if it was skipped by the
     * 23505 unique-index race guard. Callers use the boolean to decide
     * whether to proceed with post-commit Redis cleanup (resetRound,
     * deleteAllSnapshots).
     */
    private async applyDistributionTx(args: {
        groupId: string;
        blockHeight: number;
        distribution: GroupSoloPayoutEntry[];
        balanceAfter: Map<string, number>;
        consideredAddresses: Set<string>;
        diffByAddr: Map<string, number>;
        totalDiffRound: number;
        windowAddrs: Set<string>;
        label: string;
    }): Promise<boolean> {
        const {
            groupId, blockHeight, distribution, balanceAfter,
            consideredAddresses, diffByAddr, totalDiffRound, windowAddrs, label,
        } = args;
        const distributionAddrs = new Set(distribution.map(d => d.address));

        try {
            await this.historyRepo.manager.transaction(async (em) => {
                const historyRepo = em.getRepository(PplnsGroupBlockHistoryEntity);
                const balanceRepo = em.getRepository(PplnsGroupBalanceEntity);

                // Single IN-list fetch for every balance row we might
                // touch — anyone in balanceAfter, plus distribution miners
                // (for totalPaidSats).
                const addrsNeedingBalance = new Set<string>();
                for (const addr of balanceAfter.keys()) addrsNeedingBalance.add(addr);
                for (const d of distribution) {
                    if (d.address !== this.feeAddress) addrsNeedingBalance.add(d.address);
                }
                const existingBalances = addrsNeedingBalance.size > 0
                    ? await balanceRepo.find({ where: { groupId, address: In(Array.from(addrsNeedingBalance)) } })
                    : [];
                const balanceMap = new Map(existingBalances.map(b => [b.address, b]));

                const balancesToSave = new Map<string, PplnsGroupBalanceEntity>();
                const historyRows: PplnsGroupBlockHistoryEntity[] = [];
                const now = new Date();

                // 1. Apply absolute balanceAfter values from the distribution.
                for (const [addr, newBalance] of balanceAfter) {
                    let balance = balanceMap.get(addr);
                    if (!balance) {
                        balance = balanceRepo.create({
                            address: addr, groupId,
                            pendingSats: newBalance,
                            totalPaidSats: 0,
                            lastAcceptedShareAt: now,
                        });
                        balanceMap.set(addr, balance);
                    } else {
                        balance.pendingSats = newBalance;
                        balance.lastAcceptedShareAt = now;
                    }
                    balancesToSave.set(balance.address, balance);
                }

                // 2. Coinbase outputs: history rows + totalPaidSats bump.
                for (const d of distribution) {
                    const isFee = d.address === this.feeAddress;
                    if (!isFee) {
                        let balance = balanceMap.get(d.address);
                        if (!balance) {
                            balance = balanceRepo.create({
                                address: d.address, groupId,
                                pendingSats: 0, totalPaidSats: 0,
                                lastAcceptedShareAt: now,
                            });
                            balanceMap.set(d.address, balance);
                        }
                        balance.totalPaidSats += d.sats;
                        balancesToSave.set(balance.address, balance);
                    }
                    historyRows.push(historyRepo.create({
                        groupId, blockHeight, address: d.address,
                        paidSats: d.sats, percent: d.percent,
                        sharesInRound: Math.round(diffByAddr.get(d.address) ?? 0),
                        totalSharesInRound: Math.round(totalDiffRound),
                        rowType: 'coinbase',
                    }));
                }

                // Track which addresses already have a row this block so the
                // late-arriver loop can't append a second row for the same
                // (groupId, blockHeight, address) and trip the 23505 path.
                const emittedThisBlock = new Set<string>(distributionAddrs);

                // 3. Ledger-change audit rows for addresses whose balance
                //    shifted without appearing on-chain.
                for (const addr of balanceAfter.keys()) {
                    if (emittedThisBlock.has(addr)) continue;
                    historyRows.push(historyRepo.create({
                        groupId, blockHeight, address: addr,
                        paidSats: 0, percent: 0,
                        sharesInRound: Math.round(diffByAddr.get(addr) ?? 0),
                        totalSharesInRound: Math.round(totalDiffRound),
                        rowType: 'pending',
                    }));
                    emittedThisBlock.add(addr);
                }

                // 4. Late arrivers: in window but not considered at
                //    distribution-build time → audit only, no ledger impact.
                //    Empty by construction in the recompute fallback path.
                for (const addr of windowAddrs) {
                    if (consideredAddresses.has(addr)) continue;
                    if (emittedThisBlock.has(addr)) continue;
                    historyRows.push(historyRepo.create({
                        groupId, blockHeight, address: addr,
                        paidSats: 0, percent: 0,
                        sharesInRound: Math.round(diffByAddr.get(addr) ?? 0),
                        totalSharesInRound: Math.round(totalDiffRound),
                        rowType: 'pending',
                    }));
                    emittedThisBlock.add(addr);
                    console.log(`[GroupSolo]   ${addr}: ${(diffByAddr.get(addr) ?? 0).toFixed(2)} shares in round but not in coinbase distribution (late arrival, PROP rules)`);
                }

                if (balancesToSave.size > 0) {
                    await balanceRepo.save(Array.from(balancesToSave.values()));
                }
                if (historyRows.length > 0) {
                    await historyRepo.insert(historyRows);
                }
            });
            return true;
        } catch (e: any) {
            if (e?.code === '23505') {
                console.warn(`[GroupSolo] Block ${blockHeight} (${label}) raced against duplicate write — skipping (23505)`);
                return false;
            }
            throw e;
        }
    }

    private async addPending(groupId: string, address: string, sats: number): Promise<void> {
        // Touch lastAcceptedShareAt on every credit. Convention: any row
        // that just received money gets a fresh dormancy anchor — otherwise
        // a recipient who is themselves dormant would have the dust-sweep
        // cron absorb the just-credited sats on its next run (the sweep
        // gates on pendingSats < minPayout AND lastAcceptedShareAt past
        // the dormancy cutoff). The credit shouldn't count as the
        // recipient "being active", but it should reset the clock so the
        // sweep doesn't immediately reclaim what the kick just gave them.
        const now = new Date();
        const existing = await this.balanceRepo.findOneBy({ address, groupId });
        if (existing) {
            existing.pendingSats += sats;
            existing.lastAcceptedShareAt = now;
            await this.balanceRepo.save(existing);
        } else {
            await this.balanceRepo.save(this.balanceRepo.create({
                address, groupId, pendingSats: sats, totalPaidSats: 0,
                lastAcceptedShareAt: now,
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
            // Drop the kicked member's per-finder snapshot. It would
            // otherwise live until 1h TTL or the next block-found wipe.
            // Inert (the member's stratum sessions can no longer route
            // to group-solo because the address-cache no longer marks
            // them as in an active group), but leaving it behind is just
            // dead state in Valkey.
            await this.redis.del(snapshotKeyFor(groupId, address));
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
            await this.deleteAllSnapshots(groupId);
        }
        await this.balanceRepo.delete({ groupId });
        await this.historyRepo.delete({ groupId });
    }

    /**
     * Scheduled timer-driven round reset (Variant B = wipe everything).
     *
     * Triggered by `GroupRoundResetService` per the group's configured
     * `roundResetIntervalDays` + `roundResetHourLocal` + TZ. Wipes the
     * full round state AND every member's pending balance — semantics
     * the user chose explicitly: "miner die nicht mehr in der Woche
     * drin sind, bekommen garnichts" plus the symmetric forgive-debt
     * effect (negative balances are also cleared).
     *
     * What gets wiped:
     *   - Redis live shares, counter, total, rejectedShares
     *   - Redis lastShareAt (members start "fresh" inactivity-wise)
     *   - Redis distribution snapshot
     *   - All `pplns_group_balance` rows for this group
     *
     * What survives:
     *   - `pplns_group_block_history` (audit trail of past payouts —
     *     not round state)
     *   - `pplns_group` row + member roster
     *
     * Idempotency / race protection:
     *   - `blockFoundLocks` (in-process Set) makes scheduled-vs-onBlockFound
     *     mutually exclusive within this process. Single-instance pool, so
     *     this is sufficient — no clustered-deployment failure mode to
     *     worry about. Whichever ran first finishes; the other is skipped.
     *   - `lastRoundResetAt` 60 s guard below additionally prevents a
     *     scheduled-vs-scheduled re-fire (only `scheduledRoundReset`
     *     itself updates `lastRoundResetAt` — see line 895). It does NOT
     *     gate against `onBlockFound` (which doesn't write that column);
     *     a block-found wipe at 23:59:55 followed by a calendar fire at
     *     00:00:00 will run the calendar wipe — which is correct under
     *     Variant B semantics ("everything earned in the past period gets
     *     wiped at the boundary"), the round is just empty so the wipe
     *     is a near-no-op.
     *
     * Block-found behaviour is unchanged — only timed resets wipe
     * the pending balances. See `onBlockFound` for the per-block
     * settlement flow.
     */
    async scheduledRoundReset(groupId: string): Promise<void> {
        // Skip if a block-found is in flight (the in-process lock both
        // pathways check). Block-found is the more authoritative trigger
        // and already wipes the round; racing with it would let two
        // pending-balance writes interleave.
        if (this.blockFoundLocks.has(groupId)) {
            console.log(`[GroupSolo] Skipping scheduled reset for ${groupId} — block-found in progress`);
            return;
        }

        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) {
            console.warn(`[GroupSolo] Skipping scheduled reset — group ${groupId} not found or dissolved`);
            return;
        }

        // Anti-double-fire (scheduled-vs-scheduled only): skip if the
        // previous scheduled reset ran < 60 s ago. `lastRoundResetAt` is
        // written exclusively by this method; onBlockFound does not touch
        // it (see docstring above for why that's intentional under
        // Variant B). The blockFoundLocks check above is the actual
        // serialization with the block-found path.
        const lastResetAt = group.lastRoundResetAt?.getTime() ?? 0;
        if (Date.now() - lastResetAt < 60_000) {
            console.log(`[GroupSolo] Skipping scheduled reset for ${groupId} — last scheduled reset ${Date.now() - lastResetAt}ms ago`);
            return;
        }

        console.log(`[GroupSolo] Scheduled timer-reset firing for group ${groupId} (full wipe incl. pending)`);

        if (this.isEnabled()) {
            await this.resetRound(groupId);
            const keys = redisKeys(groupId);
            await this.redis.del(keys.lastShareAt);
            await this.deleteAllSnapshots(groupId);
        }

        // Variant B: wipe ALL pending balances. Positive balances are
        // forfeit, negative are forgiven — symmetric, ledger-neutral
        // at the per-group level (the pool's books absorb the net).
        await this.balanceRepo.delete({ groupId });

        // Mark the reset for the scheduled-vs-scheduled guard above and
        // for `computeNextResetAt` / the custom-preset elapsed-check in
        // GroupRoundResetService (both anchor on this column).
        await this.groupRepo.update({ id: groupId }, { lastRoundResetAt: new Date() });
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
