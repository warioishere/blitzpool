import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolModeHashrateEntity } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';
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
   * Check for time slot transition and trigger immediate flush if needed
   */
  private checkSlotTransition(): void {
    const currentSlot = this.getTimeSlot();

    if (this.currentTimeSlot === null) {
      this.currentTimeSlot = currentSlot;
      return;
    }

    if (this.currentTimeSlot !== currentSlot) {
      console.log(`[StatisticsCoordinator] Slot transition detected (${this.currentTimeSlot} -> ${currentSlot})`);
      this.currentTimeSlot = currentSlot;
      // Note: No need to trigger another flush - we're already flushing
    }
  }

  /**
   * Main periodic flush - runs every 60 seconds
   */
  @Interval(60000)
  async flushAllStatistics(): Promise<void> {
    if (!this.redisClient) return;

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
   * Flush pool shares from Redis to database
   * Pattern: pool:shares:{timestamp} -> HASH {accepted, rejected}
   *
   * CRITICAL: Only flushes COMPLETE time slots (not current incomplete slot)
   */
  private async flushPoolShares(): Promise<void> {
    const currentSlot = TimeSlotHelper.getCurrentSlot();

    // Tier A short-circuit: no slot transition since last successful flush
    // → no possibility of new completed-slot data to flush. Skip the SCAN.
    if (this.lastFlushedSlot.poolShares === currentSlot) return;

    const pattern = 'pool:shares:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) {
      // Nothing here, but still mark this slot as "looked at" so we
      // don't re-scan every tick within this slot. Next slot transition
      // will reset the gate naturally.
      this.lastFlushedSlot.poolShares = currentSlot;
      return;
    }
    const records: Array<{ time: number; accepted: number; rejected: number }> = [];
    const keysToDelete: string[] = [];

    for (const key of keys) {
      try {
        // Extract timestamp from key (pool:shares:1234567890)
        const timeSlot = parseInt(key.split(':')[2]);

        // CRITICAL FIX: Skip current incomplete slot - only flush complete slots
        if (timeSlot === currentSlot) {
          continue;
        }

        const data = await this.redisClient.hGetAll(key);

        if (!data || (!data.accepted && !data.rejected)) continue;

        const accepted = parseFloat(data.accepted) || 0;
        const rejected = parseFloat(data.rejected) || 0;

        if (accepted === 0 && rejected === 0) continue;

        records.push({ time: timeSlot, accepted, rejected });

        // Track key for deletion AFTER successful database flush
        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to extract pool shares from ${key}:`, error);
      }
    }

    if (records.length === 0) {
      // SCAN found only the current-slot key (or nothing) — still update
      // lastFlushedSlot so we skip subsequent ticks until transition.
      this.lastFlushedSlot.poolShares = currentSlot;
      return;
    }

    // Bulk upsert to database
    try {
      await this.bulkUpsertPoolShares(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} complete pool share time slots`);
      // Mark slot done — short-circuits subsequent ticks until next transition.
      this.lastFlushedSlot.poolShares = currentSlot;

      // Delete Redis keys ONLY after successful database flush
      if (keysToDelete.length > 0) {
        await this.redisClient.del(keysToDelete);
      }
    } catch (error) {
      // Bulk insert is all-or-nothing under Postgres transactions. A single
      // out-of-range value (e.g. accepted/rejected > 3.4e38 from a corrupt
      // Redis bucket) poisons the entire batch and every subsequent flush
      // tick, freezing pool-wide chart/share/accepted endpoints.
      //
      // Fall back to per-bucket inserts so good buckets land in Postgres
      // and only the offending key is quarantined (deleted from Redis with
      // a warning, preserving accepted/rejected for the non-corrupt slots).
      console.error(
        `[StatisticsCoordinator] Bulk pool-shares flush failed (${(error as Error).message}); falling back to per-bucket inserts`,
      );
      await this.flushPoolSharesIndividually(records, keysToDelete);
    }
  }

  /**
   * Per-bucket fallback for `flushPoolShares()` when the bulk upsert is
   * rejected by Postgres. Inserts each bucket in its own statement so good
   * data still flows; for bad buckets, deletes the Redis key with a loud
   * warning so the flusher doesn't get stuck on the same poisoned bucket
   * forever. Lossy by design — but losing one corrupt 10-min bucket beats
   * losing all subsequent pool-wide stats indefinitely.
   */
  private async flushPoolSharesIndividually(
    records: Array<{ time: number; accepted: number; rejected: number }>,
    keys: string[],
  ): Promise<void> {
    let goodBuckets = 0;
    const goodKeys: string[] = [];
    const quarantineKeys: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const key = keys[i];
      try {
        await this.bulkUpsertPoolShares([record]);
        goodBuckets++;
        goodKeys.push(key);
      } catch (error) {
        console.error(
          `[StatisticsCoordinator] Quarantining corrupt pool-shares bucket ${key} (time=${record.time}, accepted=${record.accepted}, rejected=${record.rejected}): ${(error as Error).message}`,
        );
        quarantineKeys.push(key);
      }
    }

    const keysToDel = [...goodKeys, ...quarantineKeys];
    if (keysToDel.length > 0) {
      try {
        await this.redisClient.del(keysToDel);
      } catch (error) {
        console.error(
          `[StatisticsCoordinator] Failed to delete pool-shares keys after fallback flush: ${(error as Error).message}`,
        );
      }
    }

    console.log(
      `[StatisticsCoordinator] Per-bucket flush complete: ${goodBuckets} flushed, ${quarantineKeys.length} quarantined`,
    );
  }

  /**
   * Flush per-mode pool hashrate from Redis to database.
   * Pattern: pool:mode-hashrate:{timestamp} -> HASH {solo, pplns, group-solo}
   *
   * Replaces the previous direct-PG-per-share write path that hammered the
   * 3 hot rows of `pool_mode_hashrate` for the current slot under load
   * (~250 shares/s × 3 rows starved the 10-conn PG pool with row locks
   * and bled into other coordinator flushes — see incident 2026-05-05).
   *
   * Atomicity: read snapshot via HGETALL, upsert to PG, then atomically
   * `HINCRBYFLOAT(-delta)` exactly what we flushed. Any straggler share
   * that wrote into the same key field between HGETALL and the decrement
   * is preserved — its increment stays in Redis for the next flush. We
   * intentionally do NOT DEL the key after flush; the writer's
   * REDIS_STATISTICS_TTL reaps stale zero hashes after 24h. Mirrors the
   * race-safe pattern in `flushAddressTotals`.
   */
  private async flushPoolModeHashrate(): Promise<void> {
    const currentSlot = TimeSlotHelper.getCurrentSlot();
    if (this.lastFlushedSlot.poolModeHashrate === currentSlot) return;

    const pattern = 'pool:mode-hashrate:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) {
      this.lastFlushedSlot.poolModeHashrate = currentSlot;
      return;
    }
    type Snapshot = { key: string; timeSlot: number; fields: Array<{ mode: string; diff: number }> };
    const snapshots: Snapshot[] = [];

    // Pre-filter current slot, then pipeline the HGETALL reads. Same shape
    // as the other flushers — sequential awaits across many keys add up.
    const eligibleKeys: string[] = [];
    const eligibleTimes: number[] = [];
    for (const key of keys) {
      const timeSlot = parseInt(key.split(':')[2], 10);
      if (!Number.isFinite(timeSlot) || timeSlot === currentSlot) continue;
      eligibleKeys.push(key);
      eligibleTimes.push(timeSlot);
    }

    if (eligibleKeys.length === 0) {
      this.lastFlushedSlot.poolModeHashrate = currentSlot;
      return;
    }

    const hashResults = await this.pipelinedHGetAll(eligibleKeys);

    for (let i = 0; i < eligibleKeys.length; i++) {
      const key = eligibleKeys[i];
      const timeSlot = eligibleTimes[i];
      const data = hashResults[i];
      try {
        if (!data || Object.keys(data).length === 0) continue;

        const fields: Array<{ mode: string; diff: number }> = [];
        for (const [mode, value] of Object.entries(data)) {
          const diff = parseFloat(value as string) || 0;
          if (diff > 0) fields.push({ mode, diff });
        }

        if (fields.length > 0) snapshots.push({ key, timeSlot, fields });
      } catch (err) {
        console.error(`[StatisticsCoordinator] Failed to parse pool-mode-hashrate snapshot from ${key}:`, err);
      }
    }

    if (snapshots.length === 0) {
      this.lastFlushedSlot.poolModeHashrate = currentSlot;
      return;
    }

    // Pass 2: bulk-upsert to PG. ON CONFLICT (mode, time) means a slot
    // re-flushed (e.g. coordinator crash between PG write and Redis
    // decrement) would double-count — but the Redis decrement covers
    // exactly what was flushed, so re-entry only re-flushes whatever
    // wasn't decremented yet.
    const records: Array<{ mode: string; time: number; diff: number }> = [];
    for (const snap of snapshots) {
      for (const f of snap.fields) {
        records.push({ mode: f.mode, time: snap.timeSlot, diff: f.diff });
      }
    }

    try {
      await this.bulkUpsertPoolModeHashrate(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool mode-hashrate records across ${snapshots.length} slots`);
      this.lastFlushedSlot.poolModeHashrate = currentSlot;
    } catch (err) {
      console.error(
        `[StatisticsCoordinator] Bulk pool-mode-hashrate flush failed (${(err as Error).message}); deltas remain in Redis for retry`,
      );
      return;  // do NOT decrement — the data is still in Redis, retry next tick
    }

    // Pass 3: atomically decrement the exact deltas we just persisted.
    // Stragglers that fired during pass 2 stay in Redis and get flushed
    // on the next tick. Pipelined to avoid 3 × N round-trips.
    try {
      const pipeline = this.redisClient.multi();
      for (const snap of snapshots) {
        for (const f of snap.fields) {
          pipeline.hIncrByFloat(snap.key, f.mode, -f.diff);
        }
      }
      await pipeline.exec();
    } catch (err) {
      console.error(
        `[StatisticsCoordinator] Failed to decrement pool-mode-hashrate Redis keys after successful PG flush:`,
        err,
      );
      // Database has the data — next coordinator tick will see the same
      // (un-decremented) values and ON CONFLICT add them again. To prevent
      // double-count on re-entry, we ALSO need to retry the decrement on
      // the next tick; the easiest way is to leave the keys as-is and
      // accept that the same values will get re-flushed and the
      // ON-CONFLICT delta will absorb them. Better yet — we treat this
      // log as the alarm and let an operator look. With pipelining it
      // failing means Redis is unhealthy; bigger problems than double-
      // count.
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
   * Flush client statistics from Redis to database
   * Pattern: client:shares:{address}:{worker}:{session}:{timestamp} -> HASH {shares, acceptedCount, ...}
   *
   * CRITICAL: Only flushes COMPLETE time slots (not current incomplete slot)
   */
  private async flushClientStatistics(): Promise<void> {
    const currentSlot = TimeSlotHelper.getCurrentSlot();
    if (this.lastFlushedSlot.clientStatistics === currentSlot) return;

    const pattern = 'client:shares:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) {
      this.lastFlushedSlot.clientStatistics = currentSlot;
      return;
    }
    const records: Array<Partial<ClientStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    // Pre-filter: drop the current incomplete slot before pipelining HGETALLs.
    // Saves N network round-trips for slot keys we'd skip anyway.
    const eligibleKeys: string[] = [];
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length < 6) {
        console.warn(`[StatisticsCoordinator] Invalid client shares key format: ${key}`);
        continue;
      }
      if (parseInt(parts[5]) === currentSlot) continue;
      eligibleKeys.push(key);
    }

    if (eligibleKeys.length === 0) {
      this.lastFlushedSlot.clientStatistics = currentSlot;
      return;
    }

    // Pipelined HGETALL — one round-trip per 500 keys instead of N.
    const hashResults = await this.pipelinedHGetAll(eligibleKeys);

    for (let i = 0; i < eligibleKeys.length; i++) {
      const key = eligibleKeys[i];
      const data = hashResults[i];
      try {
        if (!data || !data.shares) continue;

        const parts = key.split(':');
        const address = parts[2];
        const clientName = parts[3];
        const sessionId = parts[4];
        const time = parseInt(parts[5]);

        // Validate required fields
        if (!address || !clientName || !sessionId || !time) {
          console.warn(`[StatisticsCoordinator] Skipping invalid client statistics (missing required fields)`);
          await this.redisClient.del(key);
          continue;
        }

        records.push({
          address,
          clientName,
          sessionId,
          time,
          shares: parseFloat(data.shares) || 0,
          acceptedCount: parseInt(data.acceptedCount) || 0,
          rejectedCount: parseInt(data.rejectedCount) || 0,
          rejectedJobNotFoundCount: parseInt(data.rejectedJobNotFoundCount) || 0,
          rejectedJobNotFoundDiff1: parseFloat(data.rejectedJobNotFoundDiff1) || 0,
          rejectedDuplicateShareCount: parseInt(data.rejectedDuplicateShareCount) || 0,
          rejectedDuplicateShareDiff1: parseFloat(data.rejectedDuplicateShareDiff1) || 0,
          rejectedLowDifficultyShareCount: parseInt(data.rejectedLowDifficultyShareCount) || 0,
          rejectedLowDifficultyShareDiff1: parseFloat(data.rejectedLowDifficultyShareDiff1) || 0,
        });

        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to parse client statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) {
      this.lastFlushedSlot.clientStatistics = currentSlot;
      return;
    }

    // Process in batches of 1000 to stay under parameter limits
    const BATCH_SIZE = 1000;
    let flushed = 0;
    const successfulKeys: string[] = [];
    const rejectedByWorker = new Map<string, { address: string; clientName: string; rejectedShares: number }>();

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchKeys = keysToDelete.slice(i, i + BATCH_SIZE);

      try {
        await this.bulkUpsertClientStatistics(batch);
        flushed += batch.length;
        // Track successfully flushed keys
        successfulKeys.push(...batchKeys);

        // Accumulate per-worker rejected totals for successfully persisted records
        for (const record of batch) {
          const mapKey = `${record.address}|${record.clientName}`;
          const entry = rejectedByWorker.get(mapKey) ?? {
            address: record.address as string,
            clientName: record.clientName as string,
            rejectedShares: 0,
          };
          entry.rejectedShares +=
            (record.rejectedJobNotFoundDiff1 as number || 0) +
            (record.rejectedDuplicateShareDiff1 as number || 0) +
            (record.rejectedLowDifficultyShareDiff1 as number || 0);
          rejectedByWorker.set(mapKey, entry);
        }
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to flush client statistics batch:`, error);
        // Don't add to successfulKeys - these will remain in Redis for retry
      }
    }

    // Delete Redis keys ONLY after successful database flush
    if (successfulKeys.length > 0) {
      try {
        await this.redisClient.del(successfulKeys);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to delete Redis keys:`, error);
      }
    }

    // Persist rejected totals into worker_shares_entity (running totals, PK lookup)
    const rejectedUpdates = [...rejectedByWorker.values()].filter(u => u.rejectedShares > 0);
    if (rejectedUpdates.length > 0) {
      try {
        await this.workerSharesService.addRejectedBulk(rejectedUpdates);
      } catch (error) {
        console.error('[StatisticsCoordinator] Failed to flush rejected worker totals:', error);
      }
    }

    if (flushed > 0) {
      console.log(`[StatisticsCoordinator] Flushed ${flushed} client statistics records`);
    }
    // Mark slot processed — even if some batches failed mid-loop, we got
    // through the SCAN; subsequent ticks within this slot have no new
    // data to find. Failed batches stay in Redis (we didn't add them to
    // successfulKeys) and will be picked up on the next slot transition.
    this.lastFlushedSlot.clientStatistics = currentSlot;
  }

  /**
   * Flush pool rejected statistics from Redis to database
   * Pattern: pool:rejected:{timestamp} -> HASH {reason1: count1, reason2: count2, ...}
   */
  private async flushPoolRejectedStatistics(): Promise<void> {
    const currentSlot = TimeSlotHelper.getCurrentSlot();
    if (this.lastFlushedSlot.poolRejected === currentSlot) return;

    const pattern = 'pool:rejected:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) {
      this.lastFlushedSlot.poolRejected = currentSlot;
      return;
    }
    const records: Array<Partial<PoolRejectedStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    // Pre-filter current slot, then pipeline the HGETALL reads.
    const eligibleKeys: string[] = [];
    const eligibleTimes: number[] = [];
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const time = parseInt(parts[2]);
      if (time === currentSlot) continue;
      eligibleKeys.push(key);
      eligibleTimes.push(time);
    }

    if (eligibleKeys.length === 0) {
      this.lastFlushedSlot.poolRejected = currentSlot;
      return;
    }

    const hashResults = await this.pipelinedHGetAll(eligibleKeys);

    for (let i = 0; i < eligibleKeys.length; i++) {
      const key = eligibleKeys[i];
      const time = eligibleTimes[i];
      const data = hashResults[i];
      try {
        if (!data || Object.keys(data).length === 0) continue;

        for (const [reason, count] of Object.entries(data)) {
          const countValue = parseFloat(count as string) || 0;
          if (countValue > 0) {
            records.push({ time, reason, count: countValue });
          }
        }

        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to parse pool rejected statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) {
      this.lastFlushedSlot.poolRejected = currentSlot;
      return;
    }

    // Bulk upsert to database
    try {
      await this.bulkUpsertPoolRejectedStatistics(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool rejected statistics records`);
      this.lastFlushedSlot.poolRejected = currentSlot;

      // Delete Redis keys ONLY after successful database flush
      if (keysToDelete.length > 0) {
        await this.redisClient.del(keysToDelete);
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush pool rejected statistics to database:', error);
      // Keys remain in Redis for retry on next flush
    }
  }

  /**
   * Flush client rejected statistics from Redis to database
   */
  private async flushClientRejectedStatistics(): Promise<void> {
    const currentSlot = TimeSlotHelper.getCurrentSlot();
    if (this.lastFlushedSlot.clientRejected === currentSlot) return;

    const pattern = 'client:rejected:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) {
      this.lastFlushedSlot.clientRejected = currentSlot;
      return;
    }
    const records: Array<Partial<ClientRejectedStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    // Pre-filter current slot, then pipeline the HGETALL reads.
    const eligibleKeys: string[] = [];
    const eligibleAddrs: string[] = [];
    const eligibleTimes: number[] = [];
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length < 4) continue;
      const address = parts[2];
      const time = parseInt(parts[3]);
      if (time === currentSlot) continue;
      eligibleKeys.push(key);
      eligibleAddrs.push(address);
      eligibleTimes.push(time);
    }

    if (eligibleKeys.length === 0) {
      this.lastFlushedSlot.clientRejected = currentSlot;
      return;
    }

    const hashResults = await this.pipelinedHGetAll(eligibleKeys);

    for (let i = 0; i < eligibleKeys.length; i++) {
      const key = eligibleKeys[i];
      const address = eligibleAddrs[i];
      const time = eligibleTimes[i];
      const data = hashResults[i];
      try {
        if (!data || Object.keys(data).length === 0) continue;

        // Hash fields are: {reason}:count and {reason}:shares — group by reason.
        const reasonStats = new Map<string, { count: number; shares: number }>();

        for (const [field, value] of Object.entries(data)) {
          const fieldParts = field.split(':');
          if (fieldParts.length < 2) continue;

          const reason = fieldParts[0];
          const type = fieldParts[1]; // 'count' or 'shares'

          if (!reasonStats.has(reason)) {
            reasonStats.set(reason, { count: 0, shares: 0 });
          }

          const stats = reasonStats.get(reason);
          if (type === 'count') {
            stats.count = parseFloat(value as string) || 0;
          } else if (type === 'shares') {
            stats.shares = parseFloat(value as string) || 0;
          }
        }

        for (const [reason, stats] of reasonStats.entries()) {
          if (stats.count > 0 || stats.shares > 0) {
            records.push({ address, time, reason, count: stats.count, shares: stats.shares });
          }
        }

        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to parse client rejected statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) {
      this.lastFlushedSlot.clientRejected = currentSlot;
      return;
    }

    // Bulk upsert to database
    try {
      await this.bulkUpsertClientRejectedStatistics(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} client rejected statistics records`);
      this.lastFlushedSlot.clientRejected = currentSlot;

      // Delete Redis keys ONLY after successful database flush
      if (keysToDelete.length > 0) {
        await this.redisClient.del(keysToDelete);
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush client rejected statistics to database:', error);
      // Keys remain in Redis for retry on next flush
    }
  }

  /**
   * Flush address totals from Redis to database
   * Pattern: shares:address:{address} -> HASH {baseline, delta}
   *
   * CRITICAL: Atomically flushes delta to database, then decrements delta.
   * This prevents race conditions where shares arriving during flush could be lost.
   */
  private async flushAddressTotals(): Promise<void> {
    // Tier B: read the dirty-set instead of SCAN. The dirty-set is
    // maintained by `ShareTotalsCacheService.increment` (every share
    // SADDs the address) and bootstrapped on init via a one-time SCAN.
    // Costs O(active addresses) instead of O(total Redis keyspace).
    const dirtyAddresses = await this.smembersOrFallbackScan(
      'coord:dirty:addresses',
      'shares:address:*',
      (k) => k.startsWith('shares:address:'),
    );

    if (dirtyAddresses.length === 0) return;

    const keys = dirtyAddresses.map(addr => `shares:address:${addr}`);

    const updates: Array<{ address: string; key: string; shares: number }> = [];

    // Step 1: Pipelined read of all deltas (one round-trip per 500 keys)
    const hashResults = await this.pipelinedHGetAll(keys);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const data = hashResults[i];
      try {
        if (!data || !data.delta) continue;

        const delta = parseFloat(data.delta);
        if (delta <= 0) continue;

        // Parse key: shares:address:{address}
        const address = key.split(':')[2];

        updates.push({ address, key, shares: delta });
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to parse address total from ${key}:`, error);
      }
    }

    if (updates.length === 0) return;

    // Step 2: Update database FIRST (before modifying Redis)
    try {
      await this.addressSettingsService.addSharesBulk(
        updates.map(u => ({ address: u.address, shares: u.shares }))
      );
      console.log(`[StatisticsCoordinator] Flushed ${updates.length} address total updates`);

      // Step 3: ONLY if database succeeds, atomically decrement deltas
      // CRITICAL: We decrement by the exact amount we flushed, preserving any shares that arrived during flush
      // Uses pipelined Redis calls (3 passes) instead of sequential per-key roundtrips
      try {
        // Pass 1: Read all baselines in one pipeline
        const getBaselines = this.redisClient.multi();
        for (const update of updates) {
          getBaselines.hGetAll(update.key);
        }
        const baselineResults = await getBaselines.exec();

        // Pass 2: Decrement all deltas in one pipeline
        const decrementDeltas = this.redisClient.multi();
        for (const update of updates) {
          decrementDeltas.hIncrByFloat(update.key, 'delta', -update.shares);
        }
        await decrementDeltas.exec();

        // Pass 3: Update all baselines in one pipeline
        const updateBaselines = this.redisClient.multi();
        for (let i = 0; i < updates.length; i++) {
          const data = baselineResults[i] as Record<string, string> | null;
          const currentBaseline = parseFloat(data?.baseline ?? '0') || 0;
          updateBaselines.hSet(updates[i].key, 'baseline', (currentBaseline + updates[i].shares).toString());
        }
        await updateBaselines.exec();
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to update Redis after successful DB flush:`, error);
        // Database has the data, so this is not critical - just log it
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush address totals to database:', error);
      // DO NOT modify Redis - deltas remain intact for retry on next flush
      // This prevents share loss: any shares that arrived during this attempt are preserved
    }
  }

  /**
   * Flush worker totals from Redis to database
   * Pattern: shares:worker:{address}:{clientName} -> HASH {baseline, delta}
   * Same approach as flushAddressTotals but per-worker.
   */
  private async flushWorkerTotals(): Promise<void> {
    // Tier B: read the dirty-set instead of SCAN. Entries in the SET are
    // "{address}|{workerName}" tuples (the SET stores them as opaque
    // strings; we parse on read). Same rationale as flushAddressTotals.
    const dirtyEntries = await this.smembersOrFallbackScan(
      'coord:dirty:workers',
      'shares:worker:*',
      (k) => k.startsWith('shares:worker:') && !k.endsWith(':hydrated') && !k.endsWith(':lock'),
      (k) => {
        // Convert "shares:worker:{address}:{worker}" → "{address}|{worker}"
        // for fallback bootstrap. Worker names may contain ':' so we use
        // the first ':' after the address as the split.
        const stripped = k.substring('shares:worker:'.length);
        const colonIdx = stripped.indexOf(':');
        if (colonIdx < 0) return null;
        return `${stripped.slice(0, colonIdx)}|${stripped.slice(colonIdx + 1)}`;
      },
    );

    if (dirtyEntries.length === 0) return;

    const updates: Array<{ address: string; clientName: string; key: string; shares: number }> = [];

    // Build the actual Redis keys from the dirty-set entries.
    // The key parse-back below uses key.split(':') for consistency
    // with the pre-Tier-B SCAN flow; the dirty-set is just the source
    // of WHICH keys to load.
    const dataKeys: string[] = [];
    for (const entry of dirtyEntries) {
      const sepIdx = entry.indexOf('|');
      if (sepIdx < 0) continue;
      const address = entry.substring(0, sepIdx);
      const clientName = entry.substring(sepIdx + 1);
      dataKeys.push(`shares:worker:${address}:${clientName}`);
    }
    if (dataKeys.length === 0) return;

    const hashResults = await this.pipelinedHGetAll(dataKeys);

    for (let i = 0; i < dataKeys.length; i++) {
      const key = dataKeys[i];
      const data = hashResults[i];
      try {
        if (!data || !data.delta) continue;

        const delta = parseFloat(data.delta);
        if (delta <= 0) continue;

        // Parse key: shares:worker:{address}:{clientName}
        const parts = key.split(':');
        if (parts.length < 4) continue;
        const address = parts[2];
        const clientName = parts.slice(3).join(':');

        updates.push({ address, clientName, key, shares: delta });
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to parse worker total from ${key}:`, error);
      }
    }

    if (updates.length === 0) return;

    try {
      await this.workerSharesService.addSharesBulk(
        updates.map(u => ({ address: u.address, clientName: u.clientName, shares: u.shares }))
      );

      // Decrement deltas and update baselines (pipelined)
      try {
        const getBaselines = this.redisClient.multi();
        for (const update of updates) {
          getBaselines.hGetAll(update.key);
        }
        const baselineResults = await getBaselines.exec();

        const decrementDeltas = this.redisClient.multi();
        for (const update of updates) {
          decrementDeltas.hIncrByFloat(update.key, 'delta', -update.shares);
        }
        await decrementDeltas.exec();

        const updateBaselines = this.redisClient.multi();
        for (let i = 0; i < updates.length; i++) {
          const data = baselineResults[i] as Record<string, string> | null;
          const currentBaseline = parseFloat(data?.baseline ?? '0') || 0;
          updateBaselines.hSet(updates[i].key, 'baseline', (currentBaseline + updates[i].shares).toString());
        }
        await updateBaselines.exec();
      } catch (error) {
        console.error('[StatisticsCoordinator] Failed to update Redis after worker totals flush:', error);
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush worker totals to database:', error);
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
        // entire keyspace regardless of pattern; with the pool's
        // ~500k livehash keys plus per-slot stat keys, COUNT=100
        // meant ~5000 round-trips per scanKeys call. The coordinator
        // does 7 such scans per flush → that single knob accounted
        // for ~1-2s of the observed wall-time. 1000 cuts it 10×
        // without large per-call transfer (still well under
        // a single-block scan budget).
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
