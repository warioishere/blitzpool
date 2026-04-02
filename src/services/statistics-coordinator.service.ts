import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
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

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @InjectRepository(PoolShareStatisticsEntity)
    private readonly poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @InjectRepository(PoolRejectedStatisticsEntity)
    private readonly poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
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
      await Promise.all([
        this.flushPoolShares(),
        this.flushClientStatistics(),
        this.flushPoolRejectedStatistics(),
        this.flushClientRejectedStatistics(),
        this.flushAddressTotals(),
        this.flushWorkerTotals(),
      ]);

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
    const pattern = 'pool:shares:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const currentSlot = TimeSlotHelper.getCurrentSlot();
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

    if (records.length === 0) return;

    // Bulk upsert to database
    try {
      await this.bulkUpsertPoolShares(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} complete pool share time slots`);

      // Delete Redis keys ONLY after successful database flush
      if (keysToDelete.length > 0) {
        await this.redisClient.del(keysToDelete);
      }
    } catch (error) {
      console.error('[StatisticsCoordinator] Failed to flush pool shares to database:', error);
      // Keys remain in Redis for retry on next flush
    }
  }

  /**
   * Flush client statistics from Redis to database
   * Pattern: client:shares:{address}:{worker}:{session}:{timestamp} -> HASH {shares, acceptedCount, ...}
   *
   * CRITICAL: Only flushes COMPLETE time slots (not current incomplete slot)
   */
  private async flushClientStatistics(): Promise<void> {
    const pattern = 'client:shares:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const currentSlot = TimeSlotHelper.getCurrentSlot();
    const records: Array<Partial<ClientStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    for (const key of keys) {
      try {
        // Parse key: client:shares:{address}:{worker}:{session}:{timestamp}
        const parts = key.split(':');
        if (parts.length < 6) {
          console.warn(`[StatisticsCoordinator] Invalid client shares key format: ${key}`);
          continue;
        }

        const timeSlot = parseInt(parts[5]);

        // CRITICAL FIX: Skip current incomplete slot - only flush complete slots
        if (timeSlot === currentSlot) {
          continue;
        }

        const data = await this.redisClient.hGetAll(key);

        if (!data || !data.shares) continue;

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

        // Track key for deletion AFTER successful database flush
        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to extract client statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) return;

    // Process in batches of 1000 to stay under parameter limits
    const BATCH_SIZE = 1000;
    let flushed = 0;
    const successfulKeys: string[] = [];

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchKeys = keysToDelete.slice(i, i + BATCH_SIZE);

      try {
        await this.bulkUpsertClientStatistics(batch);
        flushed += batch.length;
        // Track successfully flushed keys
        successfulKeys.push(...batchKeys);
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

    if (flushed > 0) {
      console.log(`[StatisticsCoordinator] Flushed ${flushed} client statistics records`);
    }
  }

  /**
   * Flush pool rejected statistics from Redis to database
   * Pattern: pool:rejected:{timestamp} -> HASH {reason1: count1, reason2: count2, ...}
   */
  private async flushPoolRejectedStatistics(): Promise<void> {
    const pattern = 'pool:rejected:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const currentSlot = TimeSlotHelper.getCurrentSlot();
    const records: Array<Partial<PoolRejectedStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    for (const key of keys) {
      try {
        // Parse key: pool:rejected:{timestamp}
        const parts = key.split(':');
        if (parts.length < 3) continue;

        const time = parseInt(parts[2]);

        // CRITICAL FIX: Skip current incomplete slot - only flush complete slots
        if (time === currentSlot) {
          continue;
        }

        const data = await this.redisClient.hGetAll(key);

        if (!data || Object.keys(data).length === 0) continue;

        // Each hash field is a rejection reason, value is the count (difficulty sum)
        for (const [reason, count] of Object.entries(data)) {
          const countValue = parseFloat(count as string) || 0;
          if (countValue > 0) {
            records.push({
              time,
              reason,
              count: countValue,
            });
          }
        }

        // Track key for deletion AFTER successful database flush
        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to extract pool rejected statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) return;

    // Bulk upsert to database
    try {
      await this.bulkUpsertPoolRejectedStatistics(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} pool rejected statistics records`);

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
    const pattern = 'client:rejected:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const currentSlot = TimeSlotHelper.getCurrentSlot();
    const records: Array<Partial<ClientRejectedStatisticsEntity>> = [];
    const keysToDelete: string[] = [];

    for (const key of keys) {
      try {
        // Parse key: client:rejected:{address}:{timestamp}
        const parts = key.split(':');
        if (parts.length < 4) continue;

        const address = parts[2];
        const time = parseInt(parts[3]);

        // CRITICAL FIX: Skip current incomplete slot - only flush complete slots
        if (time === currentSlot) {
          continue;
        }

        const data = await this.redisClient.hGetAll(key);

        if (!data || Object.keys(data).length === 0) continue;

        // Hash fields are: {reason}:count and {reason}:shares
        // Group by reason
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

        // Convert to records
        for (const [reason, stats] of reasonStats.entries()) {
          if (stats.count > 0 || stats.shares > 0) {
            records.push({
              address,
              time,
              reason,
              count: stats.count,
              shares: stats.shares,
            });
          }
        }

        // Track key for deletion AFTER successful database flush
        keysToDelete.push(key);
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to extract client rejected statistics from ${key}:`, error);
      }
    }

    if (records.length === 0) return;

    // Bulk upsert to database
    try {
      await this.bulkUpsertClientRejectedStatistics(records);
      console.log(`[StatisticsCoordinator] Flushed ${records.length} client rejected statistics records`);

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
    const pattern = 'shares:address:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const updates: Array<{ address: string; key: string; shares: number }> = [];

    // Step 1: Read all deltas (but DON'T modify Redis yet)
    for (const key of keys) {
      try {
        const data = await this.redisClient.hGetAll(key);

        if (!data || !data.delta) continue;

        const delta = parseFloat(data.delta);
        if (delta <= 0) continue;

        // Parse key: shares:address:{address}
        const address = key.split(':')[2];

        updates.push({ address, key, shares: delta });
      } catch (error) {
        console.error(`[StatisticsCoordinator] Failed to extract address total from ${key}:`, error);
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
    const pattern = 'shares:worker:*';
    const keys = await this.scanKeys(pattern);

    if (keys.length === 0) return;

    const updates: Array<{ address: string; clientName: string; key: string; shares: number }> = [];

    for (const key of keys) {
      try {
        // Skip non-data keys
        if (key.endsWith(':hydrated') || key.endsWith(':lock')) continue;

        const data = await this.redisClient.hGetAll(key);
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
        console.error(`[StatisticsCoordinator] Failed to extract worker total from ${key}:`, error);
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
        COUNT: 100,
      });

      cursor = result.cursor.toString();

      if (result.keys && result.keys.length > 0) {
        result.keys.forEach(key => keysSet.add(key));  // Set prevents duplicates
      }
    } while (cursor !== '0');

    return Array.from(keysSet);  // Convert Set back to array
  }

  /**
   * Bulk upsert pool shares to database (PostgreSQL or SQLite)
   */
  private async bulkUpsertPoolShares(records: Array<{ time: number; accepted: number; rejected: number }>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // PostgreSQL: Use ON CONFLICT for atomic upserts
      const values: any[] = [];
      let paramIndex = 1;

      const valueTuples = records.map(r => {
        const tuple = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`;
        values.push(r.time, r.accepted, r.rejected);
        paramIndex += 3;
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO pool_share_statistics_entity (time, accepted, rejected)
        VALUES ${valueTuples}
        ON CONFLICT (time) DO UPDATE SET
          accepted = pool_share_statistics_entity.accepted + EXCLUDED.accepted,
          rejected = pool_share_statistics_entity.rejected + EXCLUDED.rejected,
          "updatedAt" = NOW()
      `;

      await this.poolShareStatisticsRepository.query(query, values);
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
   * Bulk upsert client statistics to database (PostgreSQL or SQLite)
   */
  private async bulkUpsertClientStatistics(records: Array<Partial<ClientStatisticsEntity>>): Promise<void> {
    const dbType = this.dataSource.options.type;

    if (dbType === 'postgres') {
      // PostgreSQL: Use ON CONFLICT DO UPDATE
      const values: any[] = [];
      let paramIndex = 1;

      const valueTuples = records.map(r => {
        const tuple = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12})`;
        values.push(
          r.address, r.clientName, r.sessionId, r.time,
          r.shares, r.acceptedCount, r.rejectedCount,
          r.rejectedJobNotFoundCount, r.rejectedJobNotFoundDiff1,
          r.rejectedDuplicateShareCount, r.rejectedDuplicateShareDiff1,
          r.rejectedLowDifficultyShareCount, r.rejectedLowDifficultyShareDiff1
        );
        paramIndex += 13;
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO client_statistics_entity
          (address, "clientName", "sessionId", time, shares, "acceptedCount", "rejectedCount",
           "rejectedJobNotFoundCount", "rejectedJobNotFoundDiff1", "rejectedDuplicateShareCount",
           "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareCount", "rejectedLowDifficultyShareDiff1")
        VALUES ${valueTuples}
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

      await this.clientStatisticsRepository.query(query, values);
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
      // PostgreSQL: Use ON CONFLICT DO UPDATE
      const values: any[] = [];
      let paramIndex = 1;

      const valueTuples = records.map(r => {
        const tuple = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`;
        values.push(r.time, r.reason, r.count);
        paramIndex += 3;
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO pool_rejected_statistics_entity (time, reason, count)
        VALUES ${valueTuples}
        ON CONFLICT (time, reason) DO UPDATE SET
          count = pool_rejected_statistics_entity.count + EXCLUDED.count,
          "updatedAt" = NOW()
      `;

      await this.poolRejectedStatisticsRepository.query(query, values);
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
      // PostgreSQL: Use ON CONFLICT DO UPDATE
      const values: any[] = [];
      let paramIndex = 1;

      const valueTuples = records.map(r => {
        const tuple = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`;
        values.push(r.address, r.time, r.reason, r.count, r.shares);
        paramIndex += 5;
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO client_rejected_statistics_entity (address, time, reason, count, shares)
        VALUES ${valueTuples}
        ON CONFLICT (address, time, reason) DO UPDATE SET
          count = client_rejected_statistics_entity.count + EXCLUDED.count,
          shares = client_rejected_statistics_entity.shares + EXCLUDED.shares,
          "updatedAt" = NOW()
      `;

      await this.clientRejectedStatisticsRepository.query(query, values);
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
