import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { normalizeBtcAddress } from '../utils/btc-address.utils';
import { PplnsBalanceService } from '../ORM/pplns-balance/pplns-balance.service';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import {
    buildCoinbaseDistribution,
    CoinbaseDistributionEntry,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
    resolveMinPayoutSats,
    BUDGET_SAFETY_MARGIN_WU,
    COINBASE_BASE_WEIGHT,
    COINBASE_OUTPUT_WEIGHT,
    COINBASE_WITNESS_COMMITMENT_WEIGHT,
    outputWeightForAddress,
} from './coinbase-distribution';
import {
    ParsedCoinbaseSnapshot,
    readStoredSnapshot,
    writeStoredSnapshot,
} from './coinbase-snapshot';
import { InflightResultCache } from '../utils/inflight-result-cache';

/**
 * PPLNS (Pay Per Last N Shares) engine.
 *
 * Tracks shares in a Redis sorted set and computes coinbase payout
 * distributions using a signed credit/debit ledger (see pplns_balance.
 * balanceSats). Window size = 4 × network_difficulty (diff-1-equivalent).
 *
 * Only active when PPLNS_PORT is configured.
 */

const PPLNS_WINDOW_FACTOR = 4;
const REDIS_KEY_SHARES = 'pplns:shares';
const REDIS_KEY_COUNTER = 'pplns:counter';
const REDIS_KEY_WINDOW_TOTAL = 'pplns:window:total';
// Per-address diff-1 aggregate for the current window. Maintained in
// lock-step with REDIS_KEY_SHARES: recordShare increments, trimWindow
// decrements. Hot-path readers use hGetAll on this hash instead of
// zRange 0 -1 over the raw share set, so lookup cost is O(N distinct
// miners) rather than O(M individual shares). At 2 000 miners ×
// ~1 share/second the raw set holds >1M entries in a normal window —
// the aggregate is a handful of kilobytes.
//
// Drift: hIncrByFloat accumulates float error over very long runs. Same
// failsafe as REDIS_KEY_WINDOW_TOTAL — every 1000 trims we do a full
// recalculate from REDIS_KEY_SHARES to reset accumulated drift.
const REDIS_KEY_WINDOW_BY_ADDRESS = 'pplns:window:by-address';
// Temp key the window recalc builds into before an atomic RENAME swap, so the
// live aggregate is never observed empty/partial during a rebuild.
const REDIS_KEY_WINDOW_REBUILD = 'pplns:window:by-address:rebuild';
// Index-window size for the streamed recalc read. Bounds memory + Redis block
// time: instead of one ZRANGE 0 -1 pulling the whole multi-million-entry set
// (~1 GB of JS strings, multi-second single-thread block), we walk it in
// chunks and aggregate incrementally.
const REBUILD_CHUNK_SIZE = 100_000;

// Coinbase snapshot — the distribution that was actually used to build
// the latest coinbase, plus the signed balance state we committed to at
// that moment. Persisted in Redis (not an in-memory Map) so a pool
// restart between getPayoutDistribution and onBlockFound doesn't lose it.
//
// The snapshot carries:
//   - distribution:          the coinbase output list (percent + sats per address)
//   - blockRewardSats:       the coinbase value this snapshot was built for
//   - consideredAddresses:   every address that was in shares or balances
//                            at build time; lets onBlockFound distinguish
//                            late arrivers (submitted after snapshot) from
//                            sub-dust / trimmed miners (were in the set)
//   - balanceAfter:          new absolute balance per address that changed,
//                            produced by buildCoinbaseDistribution. Applied
//                            as absolute writes in the block-found TX.
const REDIS_KEY_SNAPSHOT = 'pplns:snapshot';
const SNAPSHOT_TTL_SECONDS = 60 * 60; // 1h — covers worst-case block-find + restart window.

// DUST_LIMIT_SATS + coinbase weight constants live in
// ./coinbase-distribution.ts — single source of truth.

/**
 * PPLNS-engine view of a coinbase output. Structurally identical to
 * `CoinbaseDistributionEntry` (which lives in coinbase-distribution.ts);
 * kept as a re-export so existing callers can import `PplnsPayoutEntry`
 * without depending on the underlying math module directly.
 */
export type PplnsPayoutEntry = CoinbaseDistributionEntry;

@Injectable()
export class PplnsService implements OnModuleInit, OnModuleDestroy {
    private redis: any = null;
    private enabled = false;
    private feeAddress: string;
    private feePercent: number;
    private networkDifficulty = 0;
    private jobSubscription: Subscription | null = null;
    private readonly coinbaseWeightBudget: number;
    private readonly minPayoutSats: number;

    // Distribution cache with TTL + in-flight dedup. See
    // src/utils/inflight-result-cache.ts. Key is the blockRewardSats so a
    // mempool-driven reward change invalidates the entry automatically.
    private readonly distributionCache = new InflightResultCache<number, PplnsPayoutEntry[]>(30_000);
    // Most-recent computed distribution — kept separately so the adaptive
    // capacity helper has something to peek at regardless of cache TTL or
    // reward-keyed cache eviction.
    private lastDistribution: PplnsPayoutEntry[] | null = null;

    // Block-found lock — prevents concurrent onBlockFound within this
    // process from double-processing. Cross-process idempotency is handled
    // by the pre-check on pplns_payout_history + the unique index.
    private blockFoundInProgress = false;

    // NOTE: The PPLNS share window intentionally does NOT reset after a
    // block is found. This is correct PPLNS behavior — shares within the
    // window contribute to multiple blocks. A reset would be PROP
    // (proportional) payout, not PPLNS. The sliding window protects
    // against pool-hopping attacks.

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
        this.minPayoutSats = resolveMinPayoutSats(this.configService.get('PPLNS_MIN_PAYOUT_SATS'));
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

        // Deployment migration: pre-aggregate rollouts have a populated
        // raw share set but no pplns:window:by-address hash. The first
        // post-deploy recordShare would otherwise populate the hash with
        // a single entry, and the next getPayoutDistribution would read
        // that lone entry as "the whole window" — silently excluding
        // every pre-deploy miner from the distribution.
        if (this.redis) {
            try {
                const aggEmpty = Object.keys((await this.redis.hGetAll(REDIS_KEY_WINDOW_BY_ADDRESS)) ?? {}).length === 0;
                const rawCount = typeof this.redis.zCard === 'function'
                    ? await this.redis.zCard(REDIS_KEY_SHARES)
                    : (await this.redis.zRange(REDIS_KEY_SHARES, 0, -1) ?? []).length;
                if (aggEmpty && rawCount > 0) {
                    console.log(`[PPLNS] Rebuilding window-by-address aggregate from ${rawCount} raw shares (deployment migration or post-flush cold start)`);
                    await this.recalculateWindow();
                }
            } catch (error) {
                console.warn('[PPLNS] Aggregate bootstrap check failed:', (error as Error).message);
            }
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

    getFeeConfig(): { feePercent: number; feeAddress: string; coinbaseWeightBudget: number } {
        return {
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
        };
    }

    /**
     * Port-side gate config for the PPLNS port — surfaced via
     * /api/pplns/fees so the UI can render "min 500 diff / 10 warmup
     * shares" on the mining-modes page.
     *
     * Reads the same env vars consumed by `protocol-detector.service.ts`
     * when it wires up the port; keeping the parse in one place risks
     * drift if that file changes, but doing the parse twice keeps the
     * pplns.service dependency graph light (no detour through the
     * stratum layer).
     *
     * Defaults match the detector:
     *   PPLNS_MIN_DIFFICULTY = 500
     *   PPLNS_WARMUP_SHARES  = 10
     */
    getPortGateConfig(): { minDifficulty: number; warmupShares: number } {
        const minRaw = parseFloat(this.configService.get<string>('PPLNS_MIN_DIFFICULTY') ?? '500');
        const minDifficulty = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 500;
        const warmupRaw = parseInt(this.configService.get<string>('PPLNS_WARMUP_SHARES') ?? '10', 10);
        const warmupShares = Number.isFinite(warmupRaw) && warmupRaw >= 0 ? warmupRaw : 10;
        return { minDifficulty, warmupShares };
    }

    setNetworkDifficulty(difficulty: number): void {
        if (Number.isFinite(difficulty) && difficulty > 0) {
            this.networkDifficulty = difficulty;
        }
    }

    getWindowSize(): number {
        return PPLNS_WINDOW_FACTOR * this.networkDifficulty;
    }

    /**
     * Pool's effective minimum on-chain payout (after env-clamping to
     * the Bitcoin Core dust policy floor). Surfaced to the UI via
     * `/api/pplns/fees` so the credit-progress bar can target the
     * actual payout threshold instead of the protocol-policy 546.
     */
    getMinPayoutSats(): number {
        return this.minPayoutSats;
    }

    /**
     * Worst-case capacity estimate used by the capacity monitor. Assumes
     * P2TR/P2WSH (172 WU) for every output and includes the same
     * BUDGET_SAFETY_MARGIN_WU the adaptive trim holds back, so a "you're
     * at 80 % capacity" alert reflects the same threshold the trim
     * actually enforces. Real capacity is typically higher because most
     * miners use P2WPKH (124 WU per output) — the monitor erring on the
     * pessimistic side is the operationally correct bias.
     */
    getMaxCoinbaseOutputs(): number {
        const feeOutputCount = this.feeAddress ? 1 : 0;
        return Math.floor(
            (this.coinbaseWeightBudget
                - BUDGET_SAFETY_MARGIN_WU
                - COINBASE_BASE_WEIGHT
                - COINBASE_WITNESS_COMMITMENT_WEIGHT
                - feeOutputCount * COINBASE_OUTPUT_WEIGHT)
            / COINBASE_OUTPUT_WEIGHT,
        );
    }

    /**
     * Adaptive capacity estimate based on the address-type mix of the
     * MOST RECENT payout distribution. Projects "if more miners join
     * with the same address-type mix, how many would fit?".
     *
     *   pool of 5 P2WPKH miners      → avg 124 WU → ~396 max
     *   pool of 10 P2TR miners       → avg 172 WU → ~285 max
     *   pool with 50/50 P2WPKH/P2TR  → avg 148 WU → ~332 max
     *   no active miners (cold start)→ avg 124 WU → ~396 max
     *
     * Reads the per-template cached distribution so this is essentially
     * free (no Redis round-trip). The number drifts as the address mix
     * shifts; the UI should render this as "approximately N miner slots"
     * rather than a hard limit. The hard worst-case lower bound is
     * `getMaxCoinbaseOutputs()` — that one never depends on who's
     * currently mining.
     *
     * Cold-start fallback is P2WPKH (124 WU) because >99 % of mining
     * wallets default to bech32 P2WPKH; assuming worst-case here would
     * make a fresh pool look smaller than it really is.
     */
    getMaxCoinbaseOutputsAdaptive(): number {
        const P2WPKH_OUTPUT_WEIGHT = 124;
        let avgOutputWeight = P2WPKH_OUTPUT_WEIGHT;

        if (this.lastDistribution && this.lastDistribution.length > 0) {
            let totalWeight = 0;
            let count = 0;
            for (const entry of this.lastDistribution) {
                // Skip the fee output — it's accounted for separately below.
                if (entry.address === this.feeAddress) continue;
                totalWeight += outputWeightForAddress(entry.address);
                count++;
            }
            if (count > 0) avgOutputWeight = totalWeight / count;
        }

        const feeWeight = this.feeAddress ? outputWeightForAddress(this.feeAddress) : 0;
        return Math.floor(
            (this.coinbaseWeightBudget
                - BUDGET_SAFETY_MARGIN_WU
                - COINBASE_BASE_WEIGHT
                - COINBASE_WITNESS_COMMITMENT_WEIGHT
                - feeWeight)
            / avgOutputWeight,
        );
    }

    // ── Share Recording ──────────────────────────────────────────

    async recordShare(address: string, difficulty: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        // Normalise (lowercase bech32) so callers that bypass the
        // stratum entry-points (tests, admin tools) can't fragment the
        // window across case variants. Stratum clients already
        // normalise at authorize-time — this is belt-and-suspenders.
        address = normalizeBtcAddress(address);
        if (!address) return;

        // INCR has to land first because its return value becomes the zAdd
        // score (deterministic ordering for trim). The remaining three
        // writes go into one MULTI/EXEC: one round-trip instead of three,
        // and the zset / total / per-address aggregate update atomically
        // on this connection. Tightens consistency between the raw share
        // set and the WINDOW_BY_ADDRESS hash that the hot read paths now
        // depend on. The fallback handles redis clients without multi()
        // (e.g. minimal test harnesses) — semantically identical, slower.
        const counter = await this.redis.incr(REDIS_KEY_COUNTER);
        const entry = `${address}:${difficulty}:${Date.now()}`;
        if (typeof this.redis.multi === 'function') {
            await this.redis.multi()
                .zAdd(REDIS_KEY_SHARES, { score: counter, value: entry })
                .incrByFloat(REDIS_KEY_WINDOW_TOTAL, difficulty)
                .hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, address, difficulty)
                .exec();
        } else {
            await this.redis.zAdd(REDIS_KEY_SHARES, { score: counter, value: entry });
            await this.redis.incrByFloat(REDIS_KEY_WINDOW_TOTAL, difficulty);
            await this.redis.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, address, difficulty);
        }

        this.distributionCache.invalidate();

        this.balanceService.markTouch(address);

        await this.trimWindow();
    }

    private trimCounter = 0;

    private async trimWindow(): Promise<void> {
        const windowSize = this.getWindowSize();
        if (windowSize <= 0) return;

        const totalStr = await this.redis.get(REDIS_KEY_WINDOW_TOTAL);
        let total = parseFloat(totalStr) || 0;

        while (total > windowSize) {
            const oldest = await this.redis.zRange(REDIS_KEY_SHARES, 0, 99);
            if (!oldest || oldest.length === 0) break;

            let removedDiff = 0;
            const removedByAddr = new Map<string, number>();
            for (const entry of oldest) {
                const parts = entry.split(':');
                const diff = parseFloat(parts[1]) || 0;
                removedDiff += diff;
                removedByAddr.set(parts[0], (removedByAddr.get(parts[0]) ?? 0) + diff);
            }

            await this.redis.zRemRangeByRank(REDIS_KEY_SHARES, 0, oldest.length - 1);
            total -= removedDiff;

            // Pipeline the per-address aggregate decrements: one round-trip
            // per trim iteration instead of N (where N is the number of
            // distinct addresses among the 100 oldest shares). Even with
            // small N this matters because it runs on every accepted PPLNS
            // share (recordShare → trimWindow → here) and the savings
            // compound across share rate.
            if (typeof this.redis.multi === 'function' && removedByAddr.size > 0) {
                const pipeline = this.redis.multi();
                for (const [addr, d] of removedByAddr) {
                    pipeline.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, addr, -d);
                }
                await pipeline.exec();
            } else {
                for (const [addr, d] of removedByAddr) {
                    await this.redis.hIncrByFloat(REDIS_KEY_WINDOW_BY_ADDRESS, addr, -d);
                }
            }
        }

        this.trimCounter++;

        // Periodic full-window recalc to defend against incremental-aggregate
        // drift (real-float accumulator). The recalc reads the entire share
        // zSet via `ZRANGE 0 -1` plus iterates it synchronously in JS — at
        // production window sizes (~2.3M entries) that's ~300ms of Redis
        // single-thread blocking per call. With the previous `% 1000` it
        // fired every ~20s under steady load and dominated the redis
        // SLOWLOG, blocking share-submit handlers and the coordinator-flush
        // pipeline behind it. `% 100000` reduces firing to ~once per ~30
        // minutes — drift between recalcs is on the order of single-share
        // float-rounding × N shares (sub-percent), negligible for chart
        // alignment and far below the cost of the recalc itself.
        if (this.trimCounter % 100000 === 0) {
            const rebuiltTotal = await this.recalculateWindow();
            if (rebuiltTotal !== null) total = rebuiltTotal;
        }

        await this.redis.set(REDIS_KEY_WINDOW_TOTAL, total.toString());
    }

    /**
     * Rebuild the per-address window aggregate AND recompute the window total
     * from the raw share zSet, in a single streamed pass, then atomically
     * swap the result over the live hash.
     *
     * Replaces the previous design — two separate `ZRANGE 0 -1` reads (each
     * pulling the whole multi-million-entry set into memory) plus a
     * `DEL`-then-rebuild-in-place. That was non-atomic: a single transient or
     * partial read after the DEL left the live hash empty, and recordShare
     * then silently repopulated it from new shares only, dropping established
     * miners from the payout (prod incident: 37 → 18 PPLNS miners, shares
     * massively shifted). It also read the giant set twice.
     *
     * Safety + efficiency here:
     *  - ONE streamed pass in REBUILD_CHUNK_SIZE index windows → bounded
     *    memory, no multi-second Redis block, total computed alongside.
     *  - Build into a temp key, swap via atomic RENAME → the live aggregate is
     *    never observed empty/partial.
     *  - Guard: if the streamed read didn't cover ~the whole set (partial /
     *    interrupted, or concurrent front-trim shifting indices), ABORT the
     *    swap and keep the live aggregate. A transient read can no longer turn
     *    into persistent corruption.
     *
     * Returns the recomputed total, or null when the rebuild was skipped
     * (empty source or aborted read) — caller keeps the running total.
     */
    private async recalculateWindow(): Promise<number | null> {
        const expected = await this.redis.zCard(REDIS_KEY_SHARES);
        if (!expected || expected <= 0) return null; // nothing to rebuild from

        const byAddr = new Map<string, number>();
        let total = 0;
        let seen = 0;
        for (let start = 0; start < expected; start += REBUILD_CHUNK_SIZE) {
            const entries = await this.redis.zRange(REDIS_KEY_SHARES, start, start + REBUILD_CHUNK_SIZE - 1);
            if (!entries || entries.length === 0) break;
            for (const entry of entries) {
                const c1 = entry.indexOf(':');
                if (c1 <= 0) continue;
                const c2 = entry.indexOf(':', c1 + 1);
                const diff = parseFloat(c2 === -1 ? entry.slice(c1 + 1) : entry.slice(c1 + 1, c2)) || 0;
                if (diff > 0) {
                    const addr = entry.slice(0, c1);
                    byAddr.set(addr, (byAddr.get(addr) ?? 0) + diff);
                    total += diff;
                }
            }
            seen += entries.length;
        }

        // Never swap in a partial aggregate over good live data. Tolerate a 1 %
        // shortfall (concurrent trim removing oldest entries shifts indices
        // during the streamed read); reject anything grossly truncated.
        if (seen < expected * 0.99) {
            console.warn(`[PPLNS] window recalc aborted — read ${seen}/${expected} shares (partial); keeping live aggregate`);
            return null;
        }

        // Build into the temp key, then atomically swap it over the live hash.
        await this.redis.del(REDIS_KEY_WINDOW_REBUILD);
        if (byAddr.size === 0) {
            // Source had only non-positive diffs — clear the live hash to match.
            await this.redis.del(REDIS_KEY_WINDOW_BY_ADDRESS);
            return total;
        }
        // Single hSet with the whole field map — one round-trip, no per-field
        // pipeline. RENAME then swaps it in atomically.
        const fields: Record<string, string> = {};
        for (const [addr, diff] of byAddr) {
            fields[addr] = diff.toString();
        }
        await this.redis.hSet(REDIS_KEY_WINDOW_REBUILD, fields);
        await this.redis.rename(REDIS_KEY_WINDOW_REBUILD, REDIS_KEY_WINDOW_BY_ADDRESS);
        return total;
    }

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
     * Build the current PPLNS payout distribution for coinbase construction.
     * Returns `{address, percent, sats}` entries — callers pass the array
     * straight to MiningJob. A snapshot of the full distribution result
     * (including `balanceAfter`) is persisted to Redis so that the
     * eventual onBlockFound mutates the ledger against the exact state
     * we committed at template-build time, even across a pool restart.
     */
    async getPayoutDistribution(blockRewardSats: number): Promise<PplnsPayoutEntry[]> {
        if (!this.redis || !this.enabled) {
            return this.fallbackDistribution(blockRewardSats);
        }
        return this.distributionCache.getOrCompute(
            blockRewardSats,
            () => this.buildDistribution(blockRewardSats),
        );
    }

    private async buildDistribution(blockRewardSats: number): Promise<PplnsPayoutEntry[]> {
        const addressShares = await this.readWindowByAddress();
        if (addressShares.size === 0) {
            return this.fallbackDistribution(blockRewardSats);
        }

        const balanceEntities = await this.balanceService.getAllWithBalance();
        const balances = new Map<string, number>();
        for (const e of balanceEntities) balances.set(e.address, e.balanceSats);

        const result = buildCoinbaseDistribution({
            addressShares,
            balances,
            blockRewardSats,
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
            minPayoutSats: this.minPayoutSats,
            logLabel: '[PPLNS]',
        });

        const payouts: PplnsPayoutEntry[] = result.payouts.length > 0
            ? result.payouts
            : this.fallbackDistribution(blockRewardSats);

        this.lastDistribution = payouts;

        await this.writeSnapshot({
            distribution: payouts,
            blockRewardSats,
            consideredAddresses: Array.from(result.consideredAddresses),
            balanceAfter: Array.from(result.balanceAfter.entries()),
        });

        return payouts;
    }

    private writeSnapshot(snapshot: {
        distribution: PplnsPayoutEntry[];
        blockRewardSats: number;
        consideredAddresses: string[];
        balanceAfter: Array<[string, number]>;
    }): Promise<void> {
        return writeStoredSnapshot(this.redis, REDIS_KEY_SNAPSHOT, snapshot, SNAPSHOT_TTL_SECONDS);
    }

    private readSnapshot(): Promise<ParsedCoinbaseSnapshot | null> {
        return readStoredSnapshot(this.redis, REDIS_KEY_SNAPSHOT);
    }

    private async deleteSnapshot(): Promise<void> {
        await this.redis.del(REDIS_KEY_SNAPSHOT);
    }

    private fallbackDistribution(blockRewardSats: number): PplnsPayoutEntry[] {
        if (this.feeAddress) {
            return [{ address: this.feeAddress, percent: 100, sats: blockRewardSats }];
        }
        return [];
    }

    // ── Block Found ──────────────────────────────────────────────

    /**
     * Called when a block is found on a PPLNS port. Applies the snapshot's
     * payout distribution (history rows + absolute balance writes) atomically
     * in one Postgres transaction.
     *
     * Idempotency: pre-check on pplns_payout_history.blockHeight + unique
     * index defense-in-depth. A crash mid-TX rolls back everything;
     * replay re-runs from scratch.
     */
    async onBlockFound(blockHeight: number, blockRewardSats: number): Promise<void> {
        if (!this.redis || !this.enabled) return;

        this.distributionCache.invalidate();

        if (this.blockFoundInProgress) {
            console.warn(`[PPLNS] Block ${blockHeight} — skipping, another block-found is already being processed`);
            return;
        }
        this.blockFoundInProgress = true;

        try {
            const alreadyProcessed = await this.payoutHistoryRepo.findOneBy({ blockHeight });
            if (alreadyProcessed) {
                console.log(`[PPLNS] Block ${blockHeight} already processed — skipping replay`);
                return;
            }

            console.log(`[PPLNS] Block ${blockHeight} found! Processing payouts...`);

            const snapshot = await this.readSnapshot();
            if (!snapshot || snapshot.distribution.length === 0) {
                console.warn(`[PPLNS] No coinbase snapshot available for block ${blockHeight} — recomputing from current window`);
                await this.applyDistributionWithoutSnapshot(blockHeight, blockRewardSats);
                return;
            }

            if (snapshot.blockRewardSats !== blockRewardSats) {
                console.warn(
                    `[PPLNS] Snapshot blockReward ${snapshot.blockRewardSats} != block's `
                    + `${blockRewardSats} — snapshot is for a different job, recomputing from window`,
                );
                await this.deleteSnapshot();
                await this.applyDistributionWithoutSnapshot(blockHeight, blockRewardSats);
                return;
            }

            const windowByAddr = await this.readWindowByAddress();

            await this.applyDistribution({
                blockHeight,
                distribution: snapshot.distribution,
                balanceAfter: snapshot.balanceAfter,
                consideredAddresses: snapshot.consideredAddresses,
                currentWindow: windowByAddr,
                label: 'from coinbase snapshot',
            });

            await this.deleteSnapshot();

            console.log(`[PPLNS] Block ${blockHeight} payouts processed (from coinbase snapshot)`);
        } finally {
            this.blockFoundInProgress = false;
        }
    }

    /**
     * Fallback when no snapshot is available (first block after deploy,
     * Redis flushed, reward mismatch). Rebuilds the distribution against
     * the current window + current balances, then applies it.
     *
     * **Important caveat** (M1 audit finding): the on-chain coinbase
     * was built from the TEMPLATE's distribution (which the miner saw
     * at solve-time). If shares arrived between template-send and
     * block-find, the reconstructed distribution here diverges from
     * the on-chain one. The ledger writes then reflect a best-effort
     * approximation, NOT the exact on-chain payouts. This path logs
     * a loud CRITICAL warning with a full per-miner dump so the
     * operator can manually reconcile against the block explorer;
     * the idempotency pre-check prevents any automatic retry from
     * fixing it later.
     */
    private async applyDistributionWithoutSnapshot(blockHeight: number, blockRewardSats: number): Promise<void> {
        const addressShares = await this.readWindowByAddress();
        if (addressShares.size === 0) return;

        const balanceEntities = await this.balanceService.getAllWithBalance();
        const balances = new Map<string, number>();
        for (const e of balanceEntities) balances.set(e.address, e.balanceSats);

        const result = buildCoinbaseDistribution({
            addressShares,
            balances,
            blockRewardSats,
            feePercent: this.feePercent,
            feeAddress: this.feeAddress,
            coinbaseWeightBudget: this.coinbaseWeightBudget,
            minPayoutSats: this.minPayoutSats,
            logLabel: `[PPLNS fallback ${blockHeight}]`,
        });

        // Loud operator warning: the ledger is about to be written from
        // a recomputed distribution that MAY disagree with what the
        // miner actually included in the coinbase. Dump enough info for
        // manual reconciliation against the block-explorer view.
        const onChainTotal = result.payouts.reduce((s, p) => s + p.sats, 0);
        const ledgerDelta = Array.from(result.balanceAfter.entries())
            .reduce((s, [addr, newBal]) => {
                const oldBal = balances.get(addr) ?? 0;
                return s + (newBal - oldBal);
            }, 0);
        console.warn(
            `[PPLNS CRITICAL RECOMPUTE] Block ${blockHeight} applying `
            + `RECOMPUTED distribution (no valid snapshot). ⚠️ This MAY `
            + `diverge from the actual on-chain coinbase if shares shifted `
            + `between template-send and block-find. Manually verify `
            + `against the block explorer before trusting miner payout `
            + `history for this block.\n`
            + `  blockReward:     ${blockRewardSats} sats\n`
            + `  onChain total:   ${onChainTotal} sats across ${result.payouts.length} outputs\n`
            + `  ledger delta:    ${ledgerDelta >= 0 ? '+' : ''}${ledgerDelta} sats (sum of balance changes)\n`
            + `  window miners:   ${addressShares.size}\n`
            + `  open balances:   ${balances.size}\n`
            + `  coinbase dump:   ${JSON.stringify(result.payouts.map(p => ({ a: p.address, s: p.sats })))}`,
        );

        await this.applyDistribution({
            blockHeight,
            distribution: result.payouts.map(p => ({
                address: p.address, percent: p.percent, sats: p.sats,
            })),
            balanceAfter: result.balanceAfter,
            consideredAddresses: result.consideredAddresses,
            currentWindow: addressShares,
            label: 'from window recomputation (RECOMPUTED — verify vs on-chain)',
        });
    }

    /**
     * Persist a computed distribution to the database in one TX:
     *   1. Fetch existing balance rows we'll need (one IN-list round-trip)
     *   2. For each address in balanceAfter: set balance = new absolute value
     *   3. For each address in the coinbase distribution: if not-fee, flush
     *      any pending credit that's being paid out (totalPaidSats += paid)
     *   4. Insert history rows for every coinbase output and every
     *      ledger-changed address (so the miner's payout history is
     *      complete — both on-chain payments and pending-balance shifts)
     */
    private async applyDistribution(args: {
        blockHeight: number;
        distribution: PplnsPayoutEntry[];
        balanceAfter: Map<string, number>;
        consideredAddresses: Set<string>;
        currentWindow: Map<string, number>;
        label: string;
    }): Promise<void> {
        const {
            blockHeight,
            distribution,
            balanceAfter,
            consideredAddresses,
            currentWindow,
            label,
        } = args;

        try {
            await this.payoutHistoryRepo.manager.transaction(async (em) => {
                const historyRepo = em.getRepository(PplnsPayoutHistoryEntity);
                const balanceRepo = em.getRepository(PplnsBalanceEntity);

                const addrsNeedingBalance = new Set<string>();
                for (const addr of balanceAfter.keys()) addrsNeedingBalance.add(addr);
                // Also miners in the coinbase (for totalPaidSats update
                // even if their balance goes from 0 to 0).
                for (const entry of distribution) {
                    if (entry.address !== this.feeAddress) addrsNeedingBalance.add(entry.address);
                }

                const existingBalances = addrsNeedingBalance.size > 0
                    ? await balanceRepo.find({ where: { address: In(Array.from(addrsNeedingBalance)) } })
                    : [];
                const balanceMap = new Map(existingBalances.map(b => [b.address, b]));

                const balancesToSave = new Map<string, PplnsBalanceEntity>();
                const historyRows: PplnsPayoutHistoryEntity[] = [];
                const now = Date.now();

                // 1. Apply balanceAfter (absolute writes): set every
                //    non-fee ledger entry to its new value.
                //
                //    lastAcceptedShareAt is the abandonment-sweep clock —
                //    "no inbound shares for 90 days → eligible for
                //    pair-cancellation". It must reflect the LAST TIME
                //    THE MINER ACTUALLY SUBMITTED A SHARE, not "the last
                //    time their balance row was touched". Touching it on
                //    pure-pending miners (whose balance changes only via
                //    redistribution / settlement) would reset their
                //    abandonment clock every block they were carried
                //    forward — a long-quit miner with pending credit
                //    would never become sweep-eligible. recordShare
                //    already keeps the timestamp fresh for active miners
                //    via touchLastAcceptedShareAt, so leave the field
                //    alone here for existing rows.
                const activeAddresses = new Set(currentWindow.keys());
                for (const [addr, newBalance] of balanceAfter) {
                    let balance = balanceMap.get(addr);
                    const isActive = activeAddresses.has(addr);
                    if (!balance) {
                        balance = balanceRepo.create({
                            address: addr,
                            balanceSats: newBalance,
                            totalPaidSats: 0,
                            // New rows: only stamp now() if the miner
                            // actually mined this block. Pure-pending
                            // first-time entries (e.g. carry-forward
                            // from a snapshot) start with null.
                            lastAcceptedShareAt: isActive ? now : null,
                        });
                        balanceMap.set(addr, balance);
                    } else {
                        balance.balanceSats = newBalance;
                        if (isActive) {
                            balance.lastAcceptedShareAt = now;
                        }
                    }
                    balancesToSave.set(balance.address, balance);
                }

                // 2. Coinbase outputs: history rows + totalPaidSats for miners.
                const snapshotAddresses = new Set(distribution.map(d => d.address));
                for (const entry of distribution) {
                    const isFee = entry.address === this.feeAddress;
                    if (!isFee) {
                        let balance = balanceMap.get(entry.address);
                        if (!balance) {
                            balance = balanceRepo.create({
                                address: entry.address,
                                balanceSats: 0,
                                totalPaidSats: 0,
                                lastAcceptedShareAt: now,
                            });
                            balanceMap.set(entry.address, balance);
                        }
                        balance.totalPaidSats += entry.sats;
                        balancesToSave.set(balance.address, balance);
                    }

                    historyRows.push(historyRepo.create({
                        blockHeight,
                        address: entry.address,
                        paidSats: entry.sats,
                        percent: entry.percent,
                        rowType: 'coinbase',
                    }));

                    if (isFee) {
                        console.log(`[PPLNS]   ${entry.address}: ${entry.sats} sats (pool fee, ${entry.percent.toFixed(3)} %)`);
                    } else {
                        console.log(`[PPLNS]   ${entry.address}: ${entry.sats} sats (on-chain, ${entry.percent.toFixed(3)} %)`);
                    }
                }

                // Track which addresses already have a row emitted this
                // block so step 4 (late-arriver audit) can't append a
                // second pending-row for the same (blockHeight, address)
                // and trigger the unique-index 23505 path.
                const emittedThisBlock = new Set<string>(snapshotAddresses);

                // 3. Ledger-change audit rows for addresses whose balance
                //    shifted without appearing in the coinbase — these are
                //    sub-dust / trimmed / bonus-recipient miners. Gives the
                //    miner full transparency: every block that changed
                //    their pending balance is visible in their history.
                for (const addr of balanceAfter.keys()) {
                    if (emittedThisBlock.has(addr)) continue;   // already a coinbase row
                    historyRows.push(historyRepo.create({
                        blockHeight,
                        address: addr,
                        paidSats: 0,
                        percent: 0,
                        rowType: 'pending',
                    }));
                    emittedThisBlock.add(addr);
                }

                // 4. Late arrivers: addresses in the current window that
                //    were NOT in consideredAddresses (submitted after
                //    snapshot). Audit-only row, no ledger impact — their
                //    shares remain in the sliding window and will be paid
                //    via the next block's snapshot.
                for (const addr of currentWindow.keys()) {
                    if (consideredAddresses.has(addr)) continue;
                    if (emittedThisBlock.has(addr)) continue;   // already a pending row from step 3
                    historyRows.push(historyRepo.create({
                        blockHeight,
                        address: addr,
                        paidSats: 0,
                        percent: 0,
                        rowType: 'pending',
                    }));
                    emittedThisBlock.add(addr);
                    console.log(`[PPLNS]   ${addr}: shares in window but not in snapshot (late arrival, stays for next block)`);
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
                console.warn(`[PPLNS] Block ${blockHeight} (${label}) raced against duplicate write — skipping (23505)`);
                return;
            }
            throw e;
        }
    }

    // ── Stats ────────────────────────────────────────────────────

    async getWindowStats(): Promise<{
        totalShares: number;
        windowSize: number;
        minerCount: number;
    }> {
        if (!this.redis) {
            return { totalShares: 0, windowSize: 0, minerCount: 0 };
        }

        // Read the per-address aggregate hash instead of zRange-ing the raw
        // share set. The hash is maintained lock-step with REDIS_KEY_SHARES
        // by recordShare/trimWindow and falls back to the raw set if empty
        // (see readWindowByAddress). distinct-address count and total stay
        // semantically identical to the previous zRange-based path; cost
        // drops from O(N shares) to O(N distinct miners).
        const totalStr = await this.redis.get(REDIS_KEY_WINDOW_TOTAL);
        const byAddr = await this.readWindowByAddress();

        return {
            totalShares: parseFloat(totalStr) || 0,
            windowSize: this.getWindowSize(),
            minerCount: byAddr.size,
        };
    }

    /**
     * Signed-ledger status for a specific address. `balanceSats > 0` means
     * the pool owes the miner (pending credit from sub-dust / trim).
     * `balanceSats < 0` means the miner got an on-chain bonus in an
     * earlier block and owes the pool that much, to be offset in a
     * future block. `totalPaidSats` is the lifetime sum the miner has
     * received on-chain from this pool.
     */
    async getAddressStatus(address: string): Promise<{
        balanceSats: number;
        totalPaidSats: number;
        currentWindowShares: number;
        currentWindowPercent: number;
    }> {
        const balance = await this.balanceService.getBalanceLight(address);

        let currentWindowShares = 0;
        let currentWindowPercent = 0;

        if (this.redis) {
            // Read aggregate hash (with raw-set fallback) instead of zRange
            // 0 -1 over the share window. Both addressShares and totalShares
            // match the previous semantics: the hash is maintained as the
            // diff-1 sum per address, and summing its values yields the same
            // total the old loop computed from the raw entries.
            const byAddr = await this.readWindowByAddress();
            const addressShares = byAddr.get(address) ?? 0;
            let totalShares = 0;
            for (const v of byAddr.values()) totalShares += v;

            currentWindowShares = addressShares;
            if (totalShares > 0) {
                currentWindowPercent = (addressShares / totalShares) * 100;
            }
        }

        return {
            balanceSats: balance?.balanceSats ?? 0,
            totalPaidSats: balance?.totalPaidSats ?? 0,
            currentWindowShares,
            currentWindowPercent,
        };
    }

    async getCurrentDistribution(): Promise<{ address: string; totalShares: number; percent: number }[]> {
        if (!this.redis) return [];

        // Read aggregate hash (with raw-set fallback) instead of zRange
        // 0 -1. Each map entry already holds the diff-1 sum per address —
        // the previous loop reconstructed exactly this from the raw entries.
        const addressShares = await this.readWindowByAddress();
        if (addressShares.size === 0) return [];

        let totalShares = 0;
        for (const v of addressShares.values()) totalShares += v;

        return Array.from(addressShares.entries())
            .map(([address, shares]) => ({
                address,
                totalShares: shares,
                percent: totalShares > 0 ? (shares / totalShares) * 100 : 0,
            }))
            .sort((a, b) => b.percent - a.percent);
    }

    /**
     * Pool-wide signed-ledger summary. Gives the UI (and an operator
     * dashboard) one call with everything needed to render the
     * "what does the pool owe and what is owed to it" picture:
     *
     *   - totalCreditSats:  sum of positive balances (pool owes miners)
     *   - totalDebitSats:   sum of absolute negative balances (miners owe pool)
     *   - netDriftSats:     signed sum of all balances. In a steady-state
     *                       pool this hovers near 0; persistent drift
     *                       indicates floor-rounding accumulation on the
     *                       largest miner (harmless, bounded by the sweep).
     *   - creditHolderCount / debitHolderCount: row counts by sign.
     *   - abandonedCreditSats / abandonedDebitSats: amounts sitting in
     *                       rows whose lastAcceptedShareAt is older than
     *                       the sweep cutoff — candidates for pair-
     *                       cancellation on the next sweep run.
     *   - lifetimePaidSats: sum of totalPaidSats across every miner row
     *                       (lifetime on-chain payouts via this engine).
     *
     * Expensive path? The pplns_balance table has one row per miner who
     * ever had a non-zero balance (roughly the lifetime unique miner
     * count). That's typically < 10 000 rows, so a single SUM / COUNT
     * query pair is fine without pagination.
     */
    async getLedgerSummary(abandonedDays = 90): Promise<{
        totalCreditSats: number;
        totalDebitSats: number;
        netDriftSats: number;
        creditHolderCount: number;
        debitHolderCount: number;
        abandonedCreditSats: number;
        abandonedDebitSats: number;
        lifetimePaidSats: number;
    }> {
        const all = await this.balanceService.getAll();
        const cutoff = Date.now() - abandonedDays * 24 * 60 * 60 * 1000;

        let totalCreditSats = 0;
        let totalDebitSats = 0;
        let creditHolderCount = 0;
        let debitHolderCount = 0;
        let abandonedCreditSats = 0;
        let abandonedDebitSats = 0;
        let lifetimePaidSats = 0;

        for (const row of all) {
            lifetimePaidSats += row.totalPaidSats;
            const bal = row.balanceSats;
            if (bal === 0) continue;

            const isAbandoned = row.lastAcceptedShareAt !== null
                && row.lastAcceptedShareAt < cutoff;

            if (bal > 0) {
                totalCreditSats += bal;
                creditHolderCount++;
                if (isAbandoned) abandonedCreditSats += bal;
            } else {
                totalDebitSats += -bal;
                debitHolderCount++;
                if (isAbandoned) abandonedDebitSats += -bal;
            }
        }

        return {
            totalCreditSats,
            totalDebitSats,
            netDriftSats: totalCreditSats - totalDebitSats,
            creditHolderCount,
            debitHolderCount,
            abandonedCreditSats,
            abandonedDebitSats,
            lifetimePaidSats,
        };
    }

    async getPayoutHistory(address: string, limit = 50): Promise<PplnsPayoutHistoryEntity[]> {
        return this.payoutHistoryRepo.find({
            where: { address },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }
}
