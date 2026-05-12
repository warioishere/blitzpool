import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolModeHashrateEntity } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';
import { PoolModeHashrateService } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';
import { TimeSlotHelper } from '../utils/time-slot.helper';

/**
 * Statistics Coordinator Service
 *
 * Flushes all statistics from Redis to database every 60 seconds.
 *
 * All share submissions write directly to Redis (atomic operations),
 * and this service performs periodic bulk database writes.
 *
 * Benefits:
 * - No data loss on crashes (all data in Redis immediately)
 * - Better performance (bulk operations, fewer DB round-trips)
 */
@Injectable()
export class StatisticsCoordinatorService implements OnModuleInit, OnModuleDestroy {
  private redisClient: any = null;
  private currentTimeSlot: number | null = null;
  private isFlushing: boolean = false;

  /**
   * Per-flusher consecutive-failure counter. Reset on every successful flush.
   * Once a flusher reaches FLUSH_FAILURE_WARN_THRESHOLD failures in a row,
   * the coordinator logs a WARN so an operator watching `docker logs` sees
   * that in-memory backlog is building up. Each tick is 1 minute, so the
   * warning fires after ~3 min of sustained PG inaccessibility — enough
   * slack that one slow query doesn't spam the log, but quick enough that
   * a sustained outage is visible long before OOM.
   */
  private static readonly FLUSH_FAILURE_WARN_THRESHOLD = 3;
  private flushFailures: Record<
    'poolShares' | 'poolModeHashrate' | 'clientStatistics' | 'poolRejected' | 'clientRejected'
    | 'addressTotals' | 'workerTotals',
    number
  > = {
    poolShares: 0, poolModeHashrate: 0, clientStatistics: 0,
    poolRejected: 0, clientRejected: 0,
    addressTotals: 0, workerTotals: 0,
  };

  private noteFlushSuccess(name: keyof typeof this.flushFailures): void {
    this.flushFailures[name] = 0;
  }

  private noteFlushFailure(name: keyof typeof this.flushFailures): void {
    this.flushFailures[name]++;
    if (this.flushFailures[name] >= StatisticsCoordinatorService.FLUSH_FAILURE_WARN_THRESHOLD) {
      console.warn(
        `[StatisticsCoordinator] ${name} flush has failed ${this.flushFailures[name]} consecutive times; ` +
        `in-memory backlog is growing — investigate PG connectivity`,
      );
    }
  }

  /**
   * Per-flusher tracking of the most recently completed slot we already
   * flushed to PG. The 5 slot-bound flushers below only have new data
   * at slot transitions (every 10 min); on every other tick the SCAN
   * + filter-out-current-slot work is wasted (returns zero records).
   *
   * Short-circuit pattern: at flush start, compare currentSlot to
   * lastFlushedSlot[flusher]. If equal, no transition since last
   * successful run → skip the entire flusher (no SCAN, no HGETALL,
   * no PG write).
   *
   * State is in-memory; a restart sets all to -1 so the first tick
   * after restart does a full SCAN regardless. From there the
   * bookkeeping locks in. Self-healing — a missed slot would be
   * picked up on the very next tick because the SCAN finds the
   * straggler key.
   */
  private lastFlushedSlot: {
    poolShares: number;
    poolModeHashrate: number;
    clientStatistics: number;
    poolRejected: number;
    clientRejected: number;
  } = {
    poolShares: -1,
    poolModeHashrate: -1,
    clientStatistics: -1,
    poolRejected: -1,
    clientRejected: -1,
  };

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @InjectRepository(PoolShareStatisticsEntity)
    private readonly poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @InjectRepository(PoolRejectedStatisticsEntity)
    private readonly poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
    @InjectRepository(PoolModeHashrateEntity)
    private readonly poolModeHashrateRepository: Repository<PoolModeHashrateEntity>,
    @InjectRepository(ClientStatisticsEntity)
    private readonly clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    @InjectRepository(ClientRejectedStatisticsEntity)
    private readonly clientRejectedStatisticsRepository: Repository<ClientRejectedStatisticsEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly workerSharesService: WorkerSharesService,
    private readonly shareTotalsCache: ShareTotalsCacheService,
    private readonly poolModeHashrateService: PoolModeHashrateService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        console.log('[StatisticsCoordinator] Initialized, using Redis for statistics coordination');
        console.log('[StatisticsCoordinator] Flush interval: every 60 seconds');

        // Check Redis persistence configuration (AOF/RDB)
        await this.checkRedisPersistence();

        // Ensure UNIQUE constraint exists for upsert logic
        await this.ensureUniqueConstraint();

        // Seed worker_shares_entity from client_statistics on first deploy
        await this.workerSharesService.seedIfEmpty();
      } else {
        console.error('[StatisticsCoordinator] Redis not available - coordinator cannot function without Redis');
        throw new Error('Redis required for StatisticsCoordinator');
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to initialize Redis client:', error);
      throw error;
    }
  }

  /**
   * Check Redis persistence configuration (AOF and/or RDB)
   * Warns if Redis is not configured for data persistence
   */
  private async checkRedisPersistence(): Promise<void> {
    try {
      const config = await this.redisClient.config('GET', 'appendonly');
      const aofEnabled = config && config.length >= 2 && config[1] === 'yes';

      const saveConfig = await this.redisClient.config('GET', 'save');
      const rdbEnabled = saveConfig && saveConfig.length >= 2 && saveConfig[1] !== '';

      if (!aofEnabled && !rdbEnabled) {
        console.warn('⚠️  [StatisticsCoordinator] WARNING: Redis persistence is DISABLED!');
        console.warn('⚠️  Data will be LOST on Redis restart.');
        console.warn('⚠️  Recommended: Enable AOF with "appendonly yes" in redis.conf');
      } else if (aofEnabled) {
        console.log('✓ [StatisticsCoordinator] Redis AOF (Append-Only File) is ENABLED - data persists across restarts');
      } else if (rdbEnabled) {
        console.log('✓ [StatisticsCoordinator] Redis RDB snapshots are ENABLED - periodic data persistence');
        console.log('  Note: Consider enabling AOF for more durable persistence');
      }
    } catch (error) {
      console.warn('[StatisticsCoordinator] Could not check Redis persistence configuration:', error.message);
    }
  }

  /**
   * Ensure UNIQUE constraint exists on client_statistics_entity
   * Required for INSERT OR REPLACE upsert logic to work correctly
   */
  private async ensureUniqueConstraint(): Promise<void> {
    try {
      const dbType = this.dataSource.options.type;

      if (dbType === 'sqlite') {
        // Check if UNIQUE index already exists
        const existing = await this.clientStatisticsRepository.query(`
          SELECT name FROM sqlite_master
          WHERE type='index'
          AND tbl_name='client_statistics_entity'
          AND name='UQ_client_statistics_composite'
        `);

        if (existing && existing.length > 0) {
          console.log('[StatisticsCoordinator] UNIQUE constraint already exists');
          return;
        }

        console.log('[StatisticsCoordinator] Creating UNIQUE constraint for INSERT OR REPLACE logic...');

        // Create UNIQUE index
        await this.clientStatisticsRepository.query(`
          CREATE UNIQUE INDEX UQ_client_statistics_composite
          ON client_statistics_entity (address, clientName, sessionId, time)
        `);

        console.log('[StatisticsCoordinator] UNIQUE constraint created successfully');
      } else if (dbType === 'postgres') {
        // PostgreSQL - check if constraint exists
        const existing = await this.clientStatisticsRepository.query(`
          SELECT constraint_name
          FROM information_schema.table_constraints
          WHERE table_name='client_statistics_entity'
          AND constraint_type='UNIQUE'
          AND constraint_name LIKE '%client_statistics%'
        `);

        if (existing && existing.length > 0) {
          console.log('[StatisticsCoordinator] UNIQUE constraint already exists');
          return;
        }

        console.log('[StatisticsCoordinator] Creating UNIQUE constraint for ON CONFLICT logic...');

        await this.clientStatisticsRepository.query(`
          ALTER TABLE client_statistics_entity
          ADD CONSTRAINT UQ_client_statistics_composite
          UNIQUE (address, "clientName", "sessionId", time)
        `);

        console.log('[StatisticsCoordinator] UNIQUE constraint created successfully');
      }
    } catch (error) {
      // If constraint creation fails (e.g., due to existing duplicates), log but don't crash
      console.error('[StatisticsCoordinator] Failed to create UNIQUE constraint:', error.message);
      console.error('[StatisticsCoordinator] Upsert logic may create duplicates until constraint is manually added');
    }
  }

  async onModuleDestroy(): Promise<void> {

    console.log('[StatisticsCoordinator] Flushing all pending statistics before shutdown...');
    try {
      await this.flushAllStatistics();
      console.log('[StatisticsCoordinator] Shutdown flush completed successfully');
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush on shutdown:', error);
    }
  }

  /**
   * Get current 10-minute time slot (end-time labeled)
   */
  private getTimeSlot(): number {
    return TimeSlotHelper.getCurrentSlot();
  }

  /**
   * Detect 10-min slot transitions. Returns true on the first call after a
   * transition (i.e., the previous tick was in the OLD slot, this tick in
   * the NEW slot). The caller can use this to fire an additional flush right
   * at the boundary so the just-ended slot's residual lands in PG within
   * microseconds of slot-end — long before the chart-visibility cutoff
   * (`now - 60s`) starts including it.
   *
   * On startup (`currentTimeSlot === null`) we seed without claiming a
   * transition so we don't waste the first tick on a phantom flush.
   */
  private checkSlotTransition(): boolean {
    const currentSlot = this.getTimeSlot();

    if (this.currentTimeSlot === null) {
      this.currentTimeSlot = currentSlot;
      return false;
    }

    if (this.currentTimeSlot !== currentSlot) {
      console.log(`[StatisticsCoordinator] Slot transition detected (${this.currentTimeSlot} -> ${currentSlot})`);
      this.currentTimeSlot = currentSlot;
      return true;
    }
    return false;
  }

  /**
   * Main periodic flush - runs every 60 seconds
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async flushAllStatistics(): Promise<void> {
    // Note: we used to gate this on `!this.redisClient` because every flusher
    // needed Redis. After Phase B, only PPLNS/Group-Solo money-state flushers
    // (handled in their own services elsewhere) still need Redis; the 5 stat
    // flushers below are pure in-memory + PG. So a Redis outage must NOT stop
    // the coordinator — that would silently let in-memory deltas accumulate
    // until OOM.

    // Prevent concurrent flushes (race condition protection)
    if (this.isFlushing) {
      console.log('[StatisticsCoordinator] Flush already in progress, skipping');
      return;
    }

    this.isFlushing = true;

    try {
      // Check for slot transition (triggers immediate flush if needed)
      this.checkSlotTransition();

      const startTime = Date.now();

      // Flush all statistics in parallel for better performance
      // Note: flushWorkerTotals writes shares to worker_shares_entity,
      // and flushClientStatistics writes rejectedShares to the same table.
      // Running them in parallel causes deadlocks, so worker totals run first.
      await Promise.all([
        this.flushPoolShares(),
        this.flushPoolModeHashrate(),
        this.flushClientStatistics(),
        this.flushPoolRejectedStatistics(),
        this.flushClientRejectedStatistics(),
        this.flushAddressTotals(),
      ]);
      await this.flushWorkerTotals();

      const duration = Date.now() - startTime;
      if (duration > 1000) {
        console.log(`[StatisticsCoordinator] Flush completed in ${duration}ms`);
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Flush failed:', error);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Flush pool-wide accepted / rejected share counts from the in-memory
   * accumulator to PG. Drain captures all slot buckets currently in memory;
   * the bulk upsert is INCREMENT-style (`accepted = accepted + EXCLUDED.accepted`)
   * so partial-slot flushes are idempotent. Confirm subtracts the snapshot
   * from the in-memory state, leaving residuals from concurrent writes.
   *
   * The MAX_REASONABLE_DIFFICULTY guard runs on the write side
   * (`PoolShareStatisticsService.handleShare`) so out-of-range values never
   * reach the map — no per-bucket quarantine fallback needed.
   */
  private async flushPoolShares(): Promise<void> {
    const drained = this.poolShareStatisticsService.drainSlotDeltas();
    if (drained.size === 0) return;

    const records = Array.from(drained.entries()).map(([time, b]) => ({
      time,
      accepted: b.accepted,
      rejected: b.rejected,
    }));

    try {
      await this.bulkUpsertPoolShares(records);
      this.poolShareStatisticsService.confirmFlush(drained);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool share time slots`);
      this.noteFlushSuccess('poolShares');
    } catch (error) {
      console.error(
        `[StatisticsCoordinator] Bulk pool-shares flush failed (${(error as Error).message}); deltas remain in cache for retry`,
      );
      this.noteFlushFailure('poolShares');
      // Snapshot stays in the cache; next flush retries automatically.
    }
  }

  /**
   * Flush per-mode pool hashrate from the in-memory accumulator to PG.
   *
   * The in-memory `PoolModeHashrateService` Map holds all un-flushed deltas
   * across all slots. Drain captures a snapshot of every slot's mode→diff
   * deltas; the bulk upsert uses `ON CONFLICT (mode, time) DO UPDATE
   * SET diff = diff + EXCLUDED.diff` so incremental partial flushes
   * accumulate the slot's data into PG. Confirm subtracts the snapshot
   * amounts from the cache, leaving any shares that arrived during the
   * await as residuals for the next flush.
   *
   * Crash recovery: in-memory state is lost on a hard crash. Up to ~60s
   * of unflushed slot data is gone. The `getChartVisibilityCutoffSlot()`
   * filter holds new slots back by the same 60s so a partial slot
   * never appears on a chart between crash and next flush.
   */
  private async flushPoolModeHashrate(): Promise<void> {
    const drained = this.poolModeHashrateService.drainSlotDeltas();
    if (drained.size === 0) return;

    const records: Array<{ mode: string; time: number; diff: number }> = [];
    for (const [time, modeMap] of drained) {
      for (const [mode, diff] of modeMap) {
        records.push({ mode, time, diff });
      }
    }

    try {
      await this.bulkUpsertPoolModeHashrate(records);
      this.poolModeHashrateService.confirmFlush(drained);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool mode-hashrate records across ${drained.size} slots`);
      this.noteFlushSuccess('poolModeHashrate');
    } catch (err) {
      console.error(
        `[StatisticsCoordinator] Bulk pool-mode-hashrate flush failed (${(err as Error).message}); deltas remain in cache for retry`,
      );
      this.noteFlushFailure('poolModeHashrate');
      // Snapshot stays in the cache; next flush retries automatically.
    }
  }

  private async bulkUpsertPoolModeHashrate(
    records: Array<{ mode: string; time: number; diff: number }>,
  ): Promise<void> {
    if (records.length === 0) return;
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // unnest() with parallel array params — see bulkUpsertClientStatistics.
      const modes = records.map(r => r.mode);
      const times = records.map(r => r.time);
      const diffs = records.map(r => r.diff);

      const query = `
        INSERT INTO pool_mode_hashrate (mode, time, diff)
        SELECT * FROM unnest($1::text[], $2::bigint[], $3::real[])
        ON CONFLICT (mode, "time") DO UPDATE SET
          diff = pool_mode_hashrate.diff + EXCLUDED.diff
      `;
      await this.poolModeHashrateRepository.query(query, [modes, times, diffs]);
    } else {
      // SQLite path for dev/test parity. Same accumulate-on-conflict
      // semantic as Postgres.
      const values: any[] = [];
      const valueTuples = records.map(r => {
        values.push(r.mode, r.time, r.diff);
        return `(?, ?, ?)`;
      }).join(', ');

      const query = `
        INSERT INTO pool_mode_hashrate (mode, time, diff)
        VALUES ${valueTuples}
        ON CONFLICT (mode, time) DO UPDATE SET
          diff = diff + excluded.diff
      `;
      await this.poolModeHashrateRepository.query(query, values);
    }
  }

  /**
   * Flush per-client per-slot statistics from the in-memory accumulator to PG.
   *
   * Bulk-upsert is INCREMENT-style (the existing `bulkUpsertClientStatistics`
   * uses `ON CONFLICT … DO UPDATE SET shares = shares + EXCLUDED.shares,
   * acceptedCount = acceptedCount + EXCLUDED.acceptedCount, …`) so partial-slot
   * flushes are idempotent.
   *
   * Also fans rejected-difficulty totals into worker_shares_entity via
   * workerSharesService.addRejectedBulk, preserving the per-worker rejected
   * totals on the dashboard.
   */
  private async flushClientStatistics(): Promise<void> {
    const drained = this.clientStatisticsService.drainDeltas();
    if (drained.length === 0) return;

    // Process in batches of 1000 to stay under PG parameter limits.
    const BATCH_SIZE = 1000;
    const successfullyFlushed: typeof drained = [];

    for (let i = 0; i < drained.length; i += BATCH_SIZE) {
      const batch = drained.slice(i, i + BATCH_SIZE);
      try {
        await this.bulkUpsertClientStatistics(batch);
        successfullyFlushed.push(...batch);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to flush client statistics batch:`, error);
        // Failed batch stays in the cache (we'll only confirm successful ones below).
      }
    }

    if (successfullyFlushed.length === 0) {
      this.noteFlushFailure('clientStatistics');
      return;
    }

    this.clientStatisticsService.confirmFlush(successfullyFlushed);
    console.log(`[StatisticsCoordinator] Flushed ${successfullyFlushed.length} client statistics records`);
    // Partial success (some batches failed but at least one succeeded) still
    // counts as a successful tick — backlog isn't strictly growing on the
    // flushed portion. If ALL batches failed we'd have returned above.
    this.noteFlushSuccess('clientStatistics');

    // Per-worker rejected-diff totals (for worker_shares_entity), built ONLY
    // from records that actually landed in PG. Building this from `drained`
    // would double-count on the next flush retry: failed batches stay in the
    // in-memory cache and get re-drained, but their rejected fan-out would
    // already have been bulk-applied to worker_shares_entity (which is
    // INCREMENT-on-conflict). Compute from `successfullyFlushed` so the
    // fan-out is once-per-flushed-row.
    const rejectedByWorker = new Map<string, { address: string; clientName: string; rejectedShares: number }>();
    for (const r of successfullyFlushed) {
      const mapKey = `${r.address}|${r.clientName}`;
      const entry = rejectedByWorker.get(mapKey) ?? { address: r.address, clientName: r.clientName, rejectedShares: 0 };
      entry.rejectedShares +=
        (r.rejectedJobNotFoundDiff1 || 0) +
        (r.rejectedDuplicateShareDiff1 || 0) +
        (r.rejectedLowDifficultyShareDiff1 || 0);
      rejectedByWorker.set(mapKey, entry);
    }

    const rejectedUpdates = [...rejectedByWorker.values()].filter(u => u.rejectedShares > 0);
    if (rejectedUpdates.length > 0) {
      try {
        await this.workerSharesService.addRejectedBulk(rejectedUpdates);
      } catch (error) {
        console.error('[StatisticsCoordinator] Failed to flush rejected worker totals:', error);
      }
    }
  }

  /**
   * Flush pool-wide rejected-share counts (per reason × slot) from the
   * in-memory accumulator to PG. INCREMENT-style upsert keyed on (reason, time).
   */
  private async flushPoolRejectedStatistics(): Promise<void> {
    const drained = this.poolRejectedStatisticsService.drainSlotDeltas();
    if (drained.size === 0) return;

    const records: Array<{ time: number; reason: string; count: number }> = [];
    for (const [time, reasons] of drained) {
      for (const [reason, count] of reasons) {
        records.push({ time, reason, count });
      }
    }

    try {
      await this.bulkUpsertPoolRejectedStatistics(records);
      this.poolRejectedStatisticsService.confirmFlush(drained);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool rejected statistics records`);
      this.noteFlushSuccess('poolRejected');
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush pool rejected statistics to database:', error);
      this.noteFlushFailure('poolRejected');
      // Snapshot stays in the cache; next flush retries automatically.
    }
  }

  /**
   * Flush per-client rejected-share counts (per address × slot × reason)
   * from the in-memory accumulator to PG.
   */
  private async flushClientRejectedStatistics(): Promise<void> {
    const drained = this.clientRejectedStatisticsService.drainDeltas();
    if (drained.length === 0) return;

    try {
      await this.bulkUpsertClientRejectedStatistics(drained);
      this.clientRejectedStatisticsService.confirmFlush(drained);
      console.log(`[StatisticsCoordinator] Flushed ${drained.length} client rejected statistics records`);
      this.noteFlushSuccess('clientRejected');
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush client rejected statistics to database:', error);
      this.noteFlushFailure('clientRejected');
      // Snapshot stays in the cache; next flush retries automatically.
    }
  }

  /**
   * Flush per-address lifetime share totals from the in-memory cache to PG.
   *
   * The drain/confirm pattern preserves shares that arrive between
   * `drainAddressDeltas()` and `confirmAddressFlush()` — any increment
   * during the await falls through to the residual of the next flush.
   * If the PG upsert fails, `confirmAddressFlush` is never called and the
   * full delta remains in the cache for the next flush cycle.
   */
  private async flushAddressTotals(): Promise<void> {
    const deltas = this.shareTotalsCache.drainAddressDeltas();
    if (deltas.size === 0) return;

    const updates = Array.from(deltas.entries()).map(([address, shares]) => ({ address, shares }));

    try {
      await this.addressSettingsService.addSharesBulk(updates);
      this.shareTotalsCache.confirmAddressFlush(deltas);
      console.log(`[StatisticsCoordinator] Flushed ${updates.length} address total updates`);
      this.noteFlushSuccess('addressTotals');
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush address totals to database:', error);
      this.noteFlushFailure('addressTotals');
      // Snapshot remains in the cache; next flush retries automatically.
    }
  }

  /**
   * Flush per-worker lifetime share totals from the in-memory cache to PG.
   * Same drain/confirm semantics as `flushAddressTotals`.
   */
  private async flushWorkerTotals(): Promise<void> {
    const drained = this.shareTotalsCache.drainWorkerDeltas();
    if (drained.length === 0) return;

    try {
      await this.workerSharesService.addSharesBulk(drained);
      this.shareTotalsCache.confirmWorkerFlush(drained);
      this.noteFlushSuccess('workerTotals');
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush worker totals to database:', error);
      this.noteFlushFailure('workerTotals');
      // Snapshot remains in the cache; next flush retries automatically.
    }
  }

  /**
   * Scan Redis for keys matching pattern
   * More efficient than KEYS command
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const keysSet = new Set<string>();  // Use Set to deduplicate keys (SCAN can return duplicates)
    let cursor = '0';

    do {
      const result = await this.redisClient.scan(cursor, {
        MATCH: pattern,
        // COUNT=1000 bumped from 100. Redis SCAN with MATCH iterates the
        // entire keyspace regardless of pattern; with per-slot stat
        // keys plus PPLNS / Group-Solo state, COUNT=100 meant many
        // round-trips per scanKeys call. The coordinator does 7 such
        // scans per flush — 1000 cuts the round-trip count 10× without
        // large per-call transfer (still well under a single-block
        // scan budget).
        COUNT: 1000,
      });

      cursor = result.cursor.toString();

      if (result.keys && result.keys.length > 0) {
        result.keys.forEach(key => keysSet.add(key));  // Set prevents duplicates
      }
    } while (cursor !== '0');

    return Array.from(keysSet);  // Convert Set back to array
  }

  /**
   * Tier B helper: read a dirty-set via SMEMBERS, falling back to a
   * one-time SCAN if the set is empty (bootstrap case after restart
   * or first deploy).
   *
   * On bootstrap: SCANs the canonical pattern, builds the dirty-set
   * via SADD so subsequent ticks use the fast path. The SCAN here
   * fires AT MOST once per coordinator lifetime — every share-record
   * after that maintains the SET incrementally.
   *
   * `entryFromKey` is required for fallback SCAN to translate
   * canonical keys back into dirty-set entries (e.g. for the worker
   * SET, "shares:worker:{addr}:{worker}" → "{addr}|{worker}").
   * For the address SET it's a simple substring strip.
   */
  private async smembersOrFallbackScan(
    setKey: string,
    fallbackPattern: string,
    keyPredicate: (k: string) => boolean,
    entryFromKey: (k: string) => string | null = (k) => k.split(':').slice(2).join(':'),
  ): Promise<string[]> {
    const members = await this.redisClient.sMembers(setKey);
    if (Array.isArray(members) && members.length > 0) {
      return members;
    }

    // Fallback: bootstrap the dirty-set from a one-shot SCAN.
    const scanned = await this.scanKeys(fallbackPattern);
    const filtered = scanned.filter(keyPredicate);
    const entries: string[] = [];
    for (const k of filtered) {
      const e = entryFromKey(k);
      if (e) entries.push(e);
    }
    if (entries.length > 0) {
      try {
        // Backfill the dirty-set so the next tick uses the fast path.
        // SADD with multiple args is atomic; node-redis maps the
        // string[] to variadic SADD.
        await this.redisClient.sAdd(setKey, entries);
      } catch (err) {
        console.warn(
          `[StatisticsCoordinator] Failed to backfill dirty-set ${setKey} during bootstrap:`,
          (err as Error).message,
        );
      }
    }
    return entries;
  }

  /**
   * Pipeline N HGETALLs into one Redis round-trip per batch.
   *
   * Replaces sequential `for (key) { await hGetAll(key) }` loops which add
   * one network round-trip per key. With 1500+ keys per flush (worker
   * totals) and ~3 ms RTT, sequential reads alone burn 4-5s every flush.
   * Pipelined: ~50 ms total for the same key count.
   *
   * Returns hashes in the SAME ORDER as the input keys array; missing or
   * errored entries are mapped to null. Batched at 500 keys/pipeline so
   * a hot pool with 10k+ session keys doesn't allocate one giant buffer.
   */
  private async pipelinedHGetAll(keys: string[]): Promise<Array<Record<string, string> | null>> {
    if (keys.length === 0) return [];
    const BATCH = 500;
    const out: Array<Record<string, string> | null> = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      const pipeline = this.redisClient.multi();
      for (const key of batch) pipeline.hGetAll(key);
      const results = await pipeline.exec();
      for (const r of results) {
        // node-redis v4 returns the hash object directly for hGetAll;
        // null/undefined / array (error reply) → mapped to null so the
        // caller's null-check protects downstream parsing.
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          out.push(r as Record<string, string>);
        } else {
          out.push(null);
        }
      }
    }
    return out;
  }

  /**
   * Bulk upsert pool shares to database (PostgreSQL or SQLite)
   */
  private async bulkUpsertPoolShares(records: Array<{ time: number; accepted: number; rejected: number }>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // unnest() with parallel array params (~9× faster than VALUES list,
      // see comment on bulkUpsertClientStatistics for the breakdown).
      const times = records.map(r => r.time);
      const accepted = records.map(r => r.accepted);
      const rejected = records.map(r => r.rejected);

      const query = `
        INSERT INTO pool_share_statistics_entity (time, accepted, rejected)
        SELECT * FROM unnest($1::bigint[], $2::real[], $3::real[])
        ON CONFLICT (time) DO UPDATE SET
          accepted = pool_share_statistics_entity.accepted + EXCLUDED.accepted,
          rejected = pool_share_statistics_entity.rejected + EXCLUDED.rejected,
          "updatedAt" = NOW()
      `;

      await this.poolShareStatisticsRepository.query(query, [times, accepted, rejected]);
    } else {
      // SQLite: Use INSERT ... ON CONFLICT to accumulate shares (not replace)
      const values: any[] = [];
      const valueTuples = records.map(r => {
        const tuple = `(?, ?, ?)`;
        values.push(r.time, r.accepted, r.rejected);
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO pool_share_statistics_entity (time, accepted, rejected)
        VALUES ${valueTuples}
        ON CONFLICT (time) DO UPDATE SET
          accepted = accepted + excluded.accepted,
          rejected = rejected + excluded.rejected,
          updatedAt = datetime('now')
      `;

      await this.poolShareStatisticsRepository.query(query, values);
    }
  }

  /**
   * Bulk upsert client statistics to database (PostgreSQL or SQLite).
   *
   * PostgreSQL path uses `unnest()` with 13 parallel array params instead of
   * 1700 × 13 = 22k positional placeholders in a giant VALUES list. Wins:
   *   - JS does 13 `Array.map` instead of building a 100-200 KB SQL string
   *   - Pg-wire-protocol payload shrinks ~50× (13 array binds vs 22 854 binds)
   *   - Postgres parser/planner doesn't have to digest a multi-megabyte stmt
   *   - Smaller V8 heap allocations → fewer GC pauses on the hot path
   * Local benchmark on prod hardware: 1500-row insert went 238ms → 27ms (~9×).
   * Identical ON CONFLICT semantics as the previous VALUES version.
   */
  private async bulkUpsertClientStatistics(records: Array<Partial<ClientStatisticsEntity>>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      const addresses = records.map(r => r.address);
      const clientNames = records.map(r => r.clientName);
      const sessionIds = records.map(r => r.sessionId);
      const times = records.map(r => r.time);
      const shares = records.map(r => r.shares ?? 0);
      const acceptedCounts = records.map(r => r.acceptedCount ?? 0);
      const rejectedCounts = records.map(r => r.rejectedCount ?? 0);
      const rejJnfCount = records.map(r => r.rejectedJobNotFoundCount ?? 0);
      const rejJnfDiff = records.map(r => r.rejectedJobNotFoundDiff1 ?? 0);
      const rejDupCount = records.map(r => r.rejectedDuplicateShareCount ?? 0);
      const rejDupDiff = records.map(r => r.rejectedDuplicateShareDiff1 ?? 0);
      const rejLowCount = records.map(r => r.rejectedLowDifficultyShareCount ?? 0);
      const rejLowDiff = records.map(r => r.rejectedLowDifficultyShareDiff1 ?? 0);

      const query = `
        INSERT INTO client_statistics_entity
          (address, "clientName", "sessionId", time, shares, "acceptedCount", "rejectedCount",
           "rejectedJobNotFoundCount", "rejectedJobNotFoundDiff1", "rejectedDuplicateShareCount",
           "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareCount", "rejectedLowDifficultyShareDiff1")
        SELECT * FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::bigint[],
          $5::real[], $6::int[], $7::int[],
          $8::int[], $9::real[], $10::int[], $11::real[],
          $12::int[], $13::real[]
        )
        ON CONFLICT (address, "clientName", "sessionId", time)
        DO UPDATE SET
          shares = client_statistics_entity.shares + EXCLUDED.shares,
          "acceptedCount" = client_statistics_entity."acceptedCount" + EXCLUDED."acceptedCount",
          "rejectedCount" = client_statistics_entity."rejectedCount" + EXCLUDED."rejectedCount",
          "rejectedJobNotFoundCount" = client_statistics_entity."rejectedJobNotFoundCount" + EXCLUDED."rejectedJobNotFoundCount",
          "rejectedJobNotFoundDiff1" = client_statistics_entity."rejectedJobNotFoundDiff1" + EXCLUDED."rejectedJobNotFoundDiff1",
          "rejectedDuplicateShareCount" = client_statistics_entity."rejectedDuplicateShareCount" + EXCLUDED."rejectedDuplicateShareCount",
          "rejectedDuplicateShareDiff1" = client_statistics_entity."rejectedDuplicateShareDiff1" + EXCLUDED."rejectedDuplicateShareDiff1",
          "rejectedLowDifficultyShareCount" = client_statistics_entity."rejectedLowDifficultyShareCount" + EXCLUDED."rejectedLowDifficultyShareCount",
          "rejectedLowDifficultyShareDiff1" = client_statistics_entity."rejectedLowDifficultyShareDiff1" + EXCLUDED."rejectedLowDifficultyShareDiff1",
          "updatedAt" = NOW()
      `;

      await this.clientStatisticsRepository.query(query, [
        addresses, clientNames, sessionIds, times,
        shares, acceptedCounts, rejectedCounts,
        rejJnfCount, rejJnfDiff, rejDupCount, rejDupDiff, rejLowCount, rejLowDiff,
      ]);
    } else {
      // SQLite: Use INSERT ... ON CONFLICT DO UPDATE to properly accumulate shares
      const values: any[] = [];
      const valueTuples = records.map(r => {
        const tuple = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        values.push(
          r.address, r.clientName, r.sessionId, r.time,
          r.shares, r.acceptedCount, r.rejectedCount,
          r.rejectedJobNotFoundCount, r.rejectedJobNotFoundDiff1,
          r.rejectedDuplicateShareCount, r.rejectedDuplicateShareDiff1,
          r.rejectedLowDifficultyShareCount, r.rejectedLowDifficultyShareDiff1
        );
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO client_statistics_entity
          (address, clientName, sessionId, time, shares, acceptedCount, rejectedCount,
           rejectedJobNotFoundCount, rejectedJobNotFoundDiff1, rejectedDuplicateShareCount,
           rejectedDuplicateShareDiff1, rejectedLowDifficultyShareCount, rejectedLowDifficultyShareDiff1)
        VALUES ${valueTuples}
        ON CONFLICT (address, clientName, sessionId, time) DO UPDATE SET
          shares = shares + excluded.shares,
          acceptedCount = acceptedCount + excluded.acceptedCount,
          rejectedCount = rejectedCount + excluded.rejectedCount,
          rejectedJobNotFoundCount = rejectedJobNotFoundCount + excluded.rejectedJobNotFoundCount,
          rejectedJobNotFoundDiff1 = rejectedJobNotFoundDiff1 + excluded.rejectedJobNotFoundDiff1,
          rejectedDuplicateShareCount = rejectedDuplicateShareCount + excluded.rejectedDuplicateShareCount,
          rejectedDuplicateShareDiff1 = rejectedDuplicateShareDiff1 + excluded.rejectedDuplicateShareDiff1,
          rejectedLowDifficultyShareCount = rejectedLowDifficultyShareCount + excluded.rejectedLowDifficultyShareCount,
          rejectedLowDifficultyShareDiff1 = rejectedLowDifficultyShareDiff1 + excluded.rejectedLowDifficultyShareDiff1,
          updatedAt = datetime('now')
      `;

      await this.clientStatisticsRepository.query(query, values);
    }
  }

  /**
   * Bulk upsert pool rejected statistics to database (PostgreSQL or SQLite)
   */
  private async bulkUpsertPoolRejectedStatistics(records: Array<Partial<PoolRejectedStatisticsEntity>>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // unnest() with parallel array params — see bulkUpsertClientStatistics.
      const times = records.map(r => r.time);
      const reasons = records.map(r => r.reason);
      const counts = records.map(r => r.count);

      const query = `
        INSERT INTO pool_rejected_statistics_entity (time, reason, count)
        SELECT * FROM unnest($1::bigint[], $2::text[], $3::real[])
        ON CONFLICT (time, reason) DO UPDATE SET
          count = pool_rejected_statistics_entity.count + EXCLUDED.count,
          "updatedAt" = NOW()
      `;

      await this.poolRejectedStatisticsRepository.query(query, [times, reasons, counts]);
    } else {
      // SQLite: Use INSERT ... ON CONFLICT DO UPDATE to accumulate
      const values: any[] = [];
      const valueTuples = records.map(r => {
        const tuple = `(?, ?, ?)`;
        values.push(r.time, r.reason, r.count);
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO pool_rejected_statistics_entity (time, reason, count)
        VALUES ${valueTuples}
        ON CONFLICT (time, reason) DO UPDATE SET
          count = count + excluded.count,
          updatedAt = datetime('now')
      `;

      await this.poolRejectedStatisticsRepository.query(query, values);
    }
  }

  /**
   * Bulk upsert client rejected statistics to database (PostgreSQL or SQLite)
   */
  private async bulkUpsertClientRejectedStatistics(records: Array<Partial<ClientRejectedStatisticsEntity>>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // unnest() with parallel array params — see bulkUpsertClientStatistics.
      const addresses = records.map(r => r.address);
      const times = records.map(r => r.time);
      const reasons = records.map(r => r.reason);
      const counts = records.map(r => r.count);
      const shares = records.map(r => r.shares);

      const query = `
        INSERT INTO client_rejected_statistics_entity (address, time, reason, count, shares)
        SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::real[], $5::real[])
        ON CONFLICT (address, time, reason) DO UPDATE SET
          count = client_rejected_statistics_entity.count + EXCLUDED.count,
          shares = client_rejected_statistics_entity.shares + EXCLUDED.shares,
          "updatedAt" = NOW()
      `;

      await this.clientRejectedStatisticsRepository.query(query, [addresses, times, reasons, counts, shares]);
    } else {
      // SQLite: Use INSERT ... ON CONFLICT DO UPDATE to accumulate
      const values: any[] = [];
      const valueTuples = records.map(r => {
        const tuple = `(?, ?, ?, ?, ?)`;
        values.push(r.address, r.time, r.reason, r.count, r.shares);
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO client_rejected_statistics_entity (address, time, reason, count, shares)
        VALUES ${valueTuples}
        ON CONFLICT (address, time, reason) DO UPDATE SET
          count = count + excluded.count,
          shares = shares + excluded.shares,
          updatedAt = datetime('now')
      `;

      await this.clientRejectedStatisticsRepository.query(query, values);
    }
  }
}
