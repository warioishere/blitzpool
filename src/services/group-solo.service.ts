// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

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
    CoinbaseDistributionEntry,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
    resolveMinPayoutSats,
} from './coinbase-distribution';
import {
    ParsedCoinbaseSnapshot,
    readStoredSnapshot,
    writeStoredSnapshot,
} from './coinbase-snapshot';
import { InflightResultCache } from '../utils/inflight-result-cache';

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
// ./coinbase-distribution.ts — see its docblock for invariants. Min-payout
// resolution lives there too (resolveMinPayoutSats) so the env-parse +
// dust-floor clamp has a single source of truth.

function redisKeys(groupId: string) {
    return {
        total: `groupsolo:${groupId}:total`,
        // Per-address rejected shares for the current round (diff-1 weighted).
        // No separate count key — the share value already captures real work.
        rejectedShares: `groupsolo:${groupId}:rejected-shares`,
        // Per-address last-accepted-share epoch-ms. Persists across rounds
        // (NOT cleared on block-found) so the admin-kick inactivity gate
        // can look back weeks. Mirrors the persistent
        // `pplns_group_balance.lastAcceptedShareAt` column — same name on
        // purpose: hot-path Redis cache of what the DB column tracks
        // authoritatively for the dust-sweep cron.
        lastAcceptedShareAt: `groupsolo:${groupId}:last-accepted-share-at`,
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
        // Per-address aggregate of accepted shares in the current round
        // (diff-1 weighted). This is the AUTHORITATIVE round state for
        // group-solo — there is no per-share zSet. Every read path
        // (`getRoundStats`, `getPayoutDistribution`, `onBlockFound`) and
        // member-removal serves from this O(distinct miners) hash. Keeping
        // only the aggregate (not individual shares) is what stops a
        // reset-less group from ballooning Redis.
        byAddress: `groupsolo:${groupId}:by-address`,
        // Best single-share of the round: { diff, address, time }. Updated
        // by recordShare, cleared by resetRound.
        bestShare: `groupsolo:${groupId}:best-share`,
    };
}

function snapshotKeyFor(groupId: string, finderAddress: string | null | undefined): string {
    return `groupsolo:${groupId}:snapshot:${finderAddress ?? '__none__'}`;
}

const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block+restart delay.

/**
 * Group-solo view of a coinbase output. Structurally identical to
 * `CoinbaseDistributionEntry`; kept as a re-export so callers can import
 * `GroupSoloPayoutEntry` without depending on the underlying math module.
 */
export type GroupSoloPayoutEntry = CoinbaseDistributionEntry;

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

    /** Redis flag marking the one-time legacy per-share key cleanup as done. */
    private static readonly LEGACY_CLEANUP_FLAG = 'groupsolo:legacy-share-cleanup-done';

    /** Per-group block-found reentrancy guard. */
    private blockFoundLocks = new Set<string>();

    /**
     * Per-(group, finderAddress, reward) distribution cache with TTL +
     * in-flight-promise dedup. See src/utils/inflight-result-cache.ts.
     * Cache key includes the reward so a mempool-driven reward change
     * naturally invalidates; `invalidateDistributionCache(groupId)` clears
     * the per-group prefix on round reset / block found.
     */
    private readonly distributionCache = new InflightResultCache<string, GroupSoloPayoutEntry[]>(30_000);

    /**
     * In-process round-best cache. Redis is written through on improvement
     * only so cross-process consumers stay consistent after restart.
     */
    private bestShareInMemory = new Map<string, { diff: number; address: string; time: number }>();

    private distributionCacheKey(groupId: string, finderAddress: string | undefined, blockRewardSats: number): string {
        return `${groupId}:${finderAddress ?? '__none__'}:${blockRewardSats}`;
    }

    private invalidateDistributionCache(groupId: string): void {
        this.distributionCache.invalidate(k => k.startsWith(`${groupId}:`));
    }

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
        // Group-Solo + Blockparty share the same fee config (GROUP_FEE_*),
        // independent from PPLNS. Existing deployments that only set
        // PPLNS_FEE_* keep working via the fallback.
        this.feeAddress = this.configService.get('GROUP_FEE_ADDRESS')
            ?? this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(
            this.configService.get('GROUP_FEE_PERCENT')
            ?? this.configService.get('PPLNS_FEE_PERCENT') ?? '2',
        );
        this.coinbaseWeightBudget = parseInt(
            this.configService.get('PPLNS_COINBASE_WEIGHT_BUDGET') ?? DEFAULT_COINBASE_WEIGHT_BUDGET.toString(),
            10,
        ) || DEFAULT_COINBASE_WEIGHT_BUDGET;
        // Operational minimum payout — same env var as the PPLNS engine
        // so groups inherit the pool's dust-vs-bloat policy.
        this.minPayoutSats = resolveMinPayoutSats(this.configService.get('PPLNS_MIN_PAYOUT_SATS'));
        // Group-solo is always enabled if the service is loaded — routing is
        // address-driven via the GroupService's address→group cache.
        this.enabled = true;
    }

    /** Read-only access to the configured group-lane pool fee percent. */
    public getFeePercent(): number {
        return this.feePercent;
    }

    /** Read-only access to the configured group-lane pool fee address. */
    public getFeeAddress(): string {
        return this.feeAddress;
    }

    async onModuleInit(): Promise<void> {
        if (!this.enabled) return;

        try {
            const store: any = this.cacheManager.store;
            if (store?.client) {
                this.redis = store.client;
                console.log('[GroupSolo] Service initialized with Redis');
                // One-time: reclaim memory from the legacy per-share keys.
                await this.cleanupLegacyShareKeys();
            } else {
                console.error('[GroupSolo] Redis not available — group-solo will not function!');
            }
        } catch (error) {
            console.error('[GroupSolo] Failed to access Redis client:', error);
        }
    }

    /**
     * One-time cleanup of legacy per-share keys orphaned by the move to the
     * by-address aggregate. `groupsolo:<id>:shares` (formerly the per-share
     * zSet — up to GBs for a group that mines without finding a block and has
     * no reset) and `groupsolo:<id>:counter` are no longer written or read;
     * nothing else deletes them and they carry no TTL. Scan + UNLINK
     * (non-blocking) on startup so the freed memory is reclaimed without a
     * manual operator step. The `*:shares` glob ends in `:shares`, so it can't
     * match the live `*:rejected-shares` hashes. Idempotent: a no-op once gone.
     */
    private async cleanupLegacyShareKeys(): Promise<void> {
        if (!this.redis) return;
        // One-time guard: once cleaned, every later restart is a single GET
        // instead of a keyspace SCAN. The new code never writes :shares /
        // :counter, so orphans can't reappear — the flag is safe to trust.
        try {
            if (await this.redis.get(GroupSoloService.LEGACY_CLEANUP_FLAG)) return;
        } catch { /* flag read failed — fall through and attempt the scan */ }
        for (const pattern of ['groupsolo:*:shares', 'groupsolo:*:counter']) {
            try {
                let cursor = 0;
                let removed = 0;
                do {
                    const result = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 1000 });
                    cursor = result.cursor;
                    if (result.keys && result.keys.length > 0) {
                        if (typeof this.redis.unlink === 'function') {
                            await this.redis.unlink(result.keys);
                        } else {
                            await this.redis.del(result.keys);
                        }
                        removed += result.keys.length;
                    }
                } while (cursor !== 0);
                if (removed > 0) {
                    console.log(`[GroupSolo] Reclaimed ${removed} orphaned legacy key(s) matching ${pattern}`);
                }
            } catch (err) {
                console.warn(`[GroupSolo] legacy key cleanup (${pattern}) failed:`, (err as Error).message);
            }
        }
        // Mark done so future restarts skip the scan (O(1) GET above).
        try { await this.redis.set(GroupSoloService.LEGACY_CLEANUP_FLAG, '1'); } catch { /* non-fatal */ }
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

        // Round state is stored purely as per-address aggregates — no
        // per-share entries. `byAddress` holds each miner's Σdifficulty,
        // `total` the round sum, `lastAcceptedShareAt` the inactivity clock.
        // The PROP distribution only needs per-address sums, so there's
        // nothing to gain from storing individual shares — and a reset-less
        // group can't balloon Redis the way a per-share zSet did. All three
        // writes share one MULTI/EXEC (one round-trip).
        if (typeof this.redis.multi === 'function') {
            await this.redis.multi()
                .incrByFloat(keys.total, difficulty)
                .hSet(keys.lastAcceptedShareAt, address, String(now))
                .hIncrByFloat(keys.byAddress, address, difficulty)
                .exec();
        } else {
            await this.redis.incrByFloat(keys.total, difficulty);
            await this.redis.hSet(keys.lastAcceptedShareAt, address, String(now));
            await this.redis.hIncrByFloat(keys.byAddress, address, difficulty);
        }

        // Round-best — read from in-process Map (no Redis round-trip per
        // share); write through to Redis only on improvement so the cross-
        // process consumers (UI /best-difficulty, kick handler) see a
        // consistent value after a restart.
        const cachedBest = this.bestShareInMemory.get(entry.groupId);
        if (!cachedBest || difficulty > cachedBest.diff) {
            this.bestShareInMemory.set(entry.groupId, { diff: difficulty, address, time: now });
            this.redis.hSet(keys.bestShare, {
                diff: String(difficulty),
                address,
                time: String(now),
            }).catch(() => undefined);
        }

        // Persist last-accepted-share timestamp on the balance row so the
        // dust-sweep cron can tell dormant dust from active dust. No-op
        // when the balance row doesn't exist yet — the first pending
        // credit in onBlockFound will initialize it.
        this.balanceRepo.update({ address, groupId: entry.groupId }, {
            lastAcceptedShareAt: now,
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
     * `finderAddress` may be omitted (e.g. unauthorized session). In that
     * case no bonus output is emitted and the snapshot is stored under
     * the legacy "__none__" key. The JDP path DOES pass finderAddress
     * (the JDP miner is the prospective block-finder by construction),
     * but only when ext 0x0003 (Coinbase Output Weights) has been
     * negotiated — without that extension JDP stays single-output per
     * §6.4.3 and Group-Solo isn't expressible.
     */
    async getPayoutDistribution(
        groupId: string,
        blockRewardSats: number,
        finderAddress?: string,
    ): Promise<GroupSoloPayoutEntry[]> {
        if (!this.isEnabled()) return this.fallback(blockRewardSats);

        return this.distributionCache.getOrCompute(
            this.distributionCacheKey(groupId, finderAddress, blockRewardSats),
            () => this.buildDistribution(groupId, blockRewardSats, finderAddress),
        );
    }

    private async buildDistribution(
        groupId: string,
        blockRewardSats: number,
        finderAddress: string | undefined,
    ): Promise<GroupSoloPayoutEntry[]> {
        const keys = redisKeys(groupId);
        const addressShares = await this.readByAddress(keys);
        if (addressShares.size === 0) {
            return this.fallback(blockRewardSats);
        }

        const balanceEntities = await this.balanceRepo.find({ where: { groupId } });
        const balances = new Map<string, number>();
        for (const p of balanceEntities) balances.set(p.address, p.pendingSats);

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
            suppressMatchingDebits: true,
            finderBonusSats,
            finderAddress,
        });

        const payouts: GroupSoloPayoutEntry[] = result.payouts.length > 0
            ? result.payouts
            : this.fallback(blockRewardSats);

        await this.writeSnapshot(groupId, finderAddress, {
            distribution: payouts,
            blockRewardSats,
            consideredAddresses: Array.from(result.consideredAddresses),
            balanceAfter: Array.from(result.balanceAfter.entries()),
        });
        return payouts;
    }

    private writeSnapshot(
        groupId: string,
        finderAddress: string | undefined,
        snapshot: {
            distribution: GroupSoloPayoutEntry[];
            blockRewardSats: number;
            consideredAddresses: string[];
            balanceAfter: Array<[string, number]>;
        },
    ): Promise<void> {
        return writeStoredSnapshot(
            this.redis,
            snapshotKeyFor(groupId, finderAddress),
            snapshot,
            SNAPSHOT_TTL_SECONDS,
        );
    }

    private readSnapshot(
        groupId: string,
        finderAddress: string | undefined,
    ): Promise<ParsedCoinbaseSnapshot | null> {
        return readStoredSnapshot(this.redis, snapshotKeyFor(groupId, finderAddress));
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
                const result = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 1000 });
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

            // Read the live per-address aggregate for diffByAddr / late-arriver
            // tracking (replaces the old per-share window scan).
            const keys = redisKeys(groupId);
            const windowByAddr = (await this.redis.hGetAll(keys.byAddress)) ?? {};
            const windowAddrs = new Set<string>();
            let totalDiffRound = 0;
            const diffByAddr = new Map<string, number>();
            for (const [addr, diffStr] of Object.entries(windowByAddr)) {
                const diff = parseFloat(diffStr as string) || 0;
                if (diff <= 0) continue;
                windowAddrs.add(addr);
                diffByAddr.set(addr, diff);
                totalDiffRound += diff;
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
            // inside wipeRoundState matters: clear the share window FIRST,
            // snapshots SECOND (resetRound, then deleteAllSnapshots). If a
            // concurrent stratum session calls getPayoutDistribution between
            // the two Redis ops, an empty share window triggers the early-
            // exit fallback path which does NOT write a snapshot — so no
            // stale snapshot can survive into the next round. The reverse
            // order had a small race window where a new snapshot built from
            // soon-to-be-cleared shares could outlive resetRound and trip
            // the next block's mismatch guard.
            //
            // Per-block round wipe is opt-in (resetRoundOnBlock); snapshots are
            // always dropped. The inactivity clock (lastAcceptedShareAt) always
            // survives across rounds (PROP semantics).
            await this.wipeRoundStateOnBlockFound(groupId);
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
        const byAddr = (await this.redis.hGetAll(keys.byAddress)) ?? {};
        const addrEntries = Object.entries(byAddr);
        if (addrEntries.length === 0) {
            await this.wipeRoundStateOnBlockFound(groupId);
            return;
        }

        const addressShares = new Map<string, number>();
        const diffByAddr = new Map<string, number>();
        let totalDiffRound = 0;
        for (const [addr, diffStr] of addrEntries) {
            const diff = parseFloat(diffStr as string) || 0;
            if (diff <= 0) continue;
            addressShares.set(addr, diff);
            diffByAddr.set(addr, diff);
            totalDiffRound += diff;
        }
        if (totalDiffRound <= 0) {
            await this.wipeRoundStateOnBlockFound(groupId);
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
            // Nothing to record; clear per-block state (round wipe still
            // gated on resetRoundOnBlock).
            await this.wipeRoundStateOnBlockFound(groupId);
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

        const ok = await this.applyDistributionTx({
            groupId,
            blockHeight,
            distribution: result.payouts,
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

        await this.wipeRoundStateOnBlockFound(groupId);
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
                const now = Date.now();

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
        const now = Date.now();
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
        await this.redis.del(keys.total);
        await this.redis.del(keys.rejectedShares);
        // Clear the per-address aggregate hash so it stays in sync with
        // the empty zSet — otherwise the next round's getRoundStats would
        // see stale per-address shares from the prior round.
        await this.redis.del(keys.byAddress);
        await this.redis.del(keys.bestShare);
        this.bestShareInMemory.delete(groupId);
        // lastAcceptedShareAt is intentionally NOT cleared on round reset —
        // it survives across blocks so the inactivity gate measures actual
        // time since last work, not time since last round start.
        // Invalidate the dispatch-window distribution cache for this group:
        // a round reset means any cached distribution is necessarily stale
        // (the addressShares map it was built from has just been wiped).
        this.invalidateDistributionCache(groupId);
    }

    /**
     * Wipe a group's per-round Redis state. Single helper for every code
     * path that starts a round fresh — block-found, scheduled timer wipe,
     * admin dissolve.
     *
     * Always wipes the share window (resetRound). Two opt-ins:
     *
     *   `includeSnapshots`  → also delete every per-finder coinbase
     *                          snapshot. `false` is correct only when
     *                          the caller has already deleted them or
     *                          knows none exist (recompute fallback).
     *
     *   `includeLastShareAt` → also delete the inactivity hash. `true`
     *                           for "full reset" semantics (dissolve,
     *                           scheduled-timer wipe). `false` for
     *                           block-found, where the inactivity clock
     *                           survives across rounds so the admin-kick
     *                           gate can look back weeks.
     *
     * Caller is expected to hold the relevant lock (e.g. blockFoundLocks)
     * already — this helper does not coordinate concurrency.
     */
    private async wipeRoundState(
        groupId: string,
        opts: { includeSnapshots: boolean; includeLastShareAt: boolean },
    ): Promise<void> {
        await this.resetRound(groupId);
        if (opts.includeLastShareAt) {
            await this.redis.del(redisKeys(groupId).lastAcceptedShareAt);
        }
        if (opts.includeSnapshots) {
            await this.deleteAllSnapshots(groupId);
        }
    }

    /**
     * Post-payout cleanup for a block-found event. The per-block round wipe is
     * opt-in via the group's `resetRoundOnBlock` flag:
     *
     *   - true  → wipe the share window (legacy behaviour): the round restarts
     *             empty after every block.
     *   - false → keep the share window (default): shares accumulate across
     *             blocks until a calendar preset / manual reset fires, so each
     *             block during the round pays the full reward split by the
     *             accumulated shares.
     *
     * Per-finder coinbase snapshots are ALWAYS dropped — they're built per
     * block and must not survive into the next one regardless of the flag.
     * A failed flag read defaults to NO wipe (the safe default: never silently
     * discard accumulated shares). `lastAcceptedShareAt` always survives (PROP
     * inactivity clock spans rounds).
     */
    private async wipeRoundStateOnBlockFound(groupId: string): Promise<void> {
        let resetOnBlock = false;
        try {
            const group = await this.groupRepo.findOneBy({ id: groupId });
            resetOnBlock = group?.resetRoundOnBlock === true;
        } catch (err) {
            console.warn(`[GroupSolo] resetRoundOnBlock read failed for ${groupId}, keeping round:`, (err as Error).message);
        }
        if (resetOnBlock) {
            await this.wipeRoundState(groupId, { includeSnapshots: true, includeLastShareAt: false });
        } else {
            await this.deleteAllSnapshots(groupId);
        }
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
        const raw = await this.redis.hGet(keys.lastAcceptedShareAt, address);
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
            // The member's round contribution is their by-address aggregate —
            // no per-share scan needed. Decrement the round total by it, then
            // drop the aggregate.
            const removedDiff = parseFloat((await this.redis.hGet(keys.byAddress, address)) ?? '0') || 0;
            if (removedDiff > 0) {
                await this.redis.incrByFloat(keys.total, -removedDiff);
            }
            await this.redis.hDel(keys.byAddress, address);
            await this.redis.hDel(keys.rejectedShares, address);
            await this.redis.hDel(keys.lastAcceptedShareAt, address);
            // If the kicked member held the best-share record, drop the
            // cache. The next accepted share re-seeds it.
            const inMemBest = this.bestShareInMemory.get(groupId);
            if (inMemBest && inMemBest.address === address) {
                this.bestShareInMemory.delete(groupId);
            }
            const bestHolder = await this.redis.hGet(keys.bestShare, 'address');
            if (bestHolder === address) {
                await this.redis.del(keys.bestShare);
            }
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
            // Full reset: round window, inactivity hash, all snapshots.
            // Group is being dissolved — no semantics to preserve.
            await this.wipeRoundState(groupId, { includeSnapshots: true, includeLastShareAt: true });
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
     *   - Redis round aggregate (by-address), total, rejectedShares
     *   - Redis lastAcceptedShareAt (members start "fresh" inactivity-wise)
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
        const lastResetAt = group.lastRoundResetAt ?? 0;
        if (Date.now() - lastResetAt < 60_000) {
            console.log(`[GroupSolo] Skipping scheduled reset for ${groupId} — last scheduled reset ${Date.now() - lastResetAt}ms ago`);
            return;
        }

        console.log(`[GroupSolo] Scheduled timer-reset firing for group ${groupId} (full wipe incl. pending)`);

        if (this.isEnabled()) {
            // Variant B: full reset — round window AND inactivity clock,
            // plus all snapshots. Members start fresh in every dimension.
            await this.wipeRoundState(groupId, { includeSnapshots: true, includeLastShareAt: true });
        }

        // Variant B: wipe ALL pending balances. Positive balances are
        // forfeit, negative are forgiven — symmetric, ledger-neutral
        // at the per-group level (the pool's books absorb the net).
        await this.balanceRepo.delete({ groupId });

        // Mark the reset for the scheduled-vs-scheduled guard above and
        // for `computeNextResetAt` / the custom-preset elapsed-check in
        // GroupRoundResetService (both anchor on this column).
        await this.groupRepo.update({ id: groupId }, { lastRoundResetAt: Date.now() });
    }

    // ── Stats (for API) ──────────────────────────────────────────

    /**
     * Per-address share aggregate for the current round, read from the
     * `byAddress` hash maintained by recordShare. Falls back to the raw
     * zSet on first read after deploy if the hash is empty but the zSet
     * isn't (legacy state). Backfills the hash on the way out so the next
     * read goes the fast path.
     *
     * O(distinct miners) on hot path; O(window entries) only on first
     * read post-deploy per group.
     */
    private async readByAddress(keys: ReturnType<typeof redisKeys>): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        const hash = (await this.redis.hGetAll(keys.byAddress)) ?? {};
        for (const [addr, diffStr] of Object.entries(hash)) {
            const diff = parseFloat(diffStr as string) || 0;
            if (diff > 0) out.set(addr, diff);
        }
        return out;
    }

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

        // Read the per-address aggregate hash — the authoritative round
        // state. Cost is O(distinct miners), typically dozens.
        const addressShares = await this.readByAddress(keys);
        let totalShares = 0;
        for (const v of addressShares.values()) totalShares += v;

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

        // In-process cache is authoritative when present.
        const inMem = this.bestShareInMemory.get(groupId);
        if (inMem) {
            return { bestDifficulty: inMem.diff, address: inMem.address, time: inMem.time };
        }

        const cached = await this.redis.hGetAll(keys.bestShare);
        if (cached && cached.diff) {
            const diff = parseFloat(cached.diff) || 0;
            const address = cached.address || null;
            const time = parseInt(cached.time, 10) || null;
            if (diff > 0 && address) {
                this.bestShareInMemory.set(groupId, { diff, address, time: time ?? 0 });
            }
            return { bestDifficulty: diff, address, time };
        }

        // No cached best yet. bestShare is the sole source (maintained
        // write-through in recordShare); the per-share zSet this used to
        // recompute from no longer exists. The next accepted share seeds it.
        return { bestDifficulty: 0, address: null, time: null };
    }

    async getBlockHistory(groupId: string, limit = 100): Promise<PplnsGroupBlockHistoryEntity[]> {
        return this.historyRepo.find({
            where: { groupId },
            order: { createdAt: 'DESC' },
            take: Math.min(Math.max(limit, 1), 500),
        });
    }
}
