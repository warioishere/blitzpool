import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RedisClientType } from 'redis';
import { DataSource } from 'typeorm';

import { REDIS_CLIENT } from '../providers/redis-client.provider';

/**
 * One-time migration service to adjust time slot labeling
 *
 * Changes time slot labels from start-time to end-time:
 * - Old: Slot labeled "20:40" contains data from 20:40-20:50
 * - New: Slot labeled "20:50" contains data from 20:40-20:50
 *
 * This provides more intuitive labeling and reduces perceived lag by ~10 minutes.
 *
 * Migration:
 * - Adds 10 minutes (600000ms) to time values in last 8 days only:
 *   - client_statistics_entity
 *   - pool_share_statistics_entity
 *   - pool_rejected_statistics_entity
 *   - client_rejected_statistics_entity
 * - Older data is not migrated (not displayed in UI, will be cleaned up later)
 * - Clears stale Redis keys (pool:rejected:*, pool:shares:*) BEFORE database migration
 * - Uses distributed locking to prevent concurrent runs
 * - Runs once on startup, tracks completion via migration flag in database
 */
@Injectable()
export class TimeslotMigrationService implements OnModuleInit {
  private readonly MIGRATION_KEY = 'TIMESLOT_END_TIME_MIGRATION_V2_COMPLETED';
  private readonly MIGRATION_LOCK_KEY = 'TIMESLOT_MIGRATION_LOCK';
  private readonly TIME_SLOT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
  private readonly LOCK_TTL_SECONDS = 900; // 15 minutes max migration time (safety buffer)

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientType | null,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.runMigration();
    } catch (error) {
      console.error('[TimeslotMigration] Migration failed:', error);
      // Don't crash the app, but log prominently
      console.error('[TimeslotMigration] ⚠️  App will start but time slots may be incorrect!');
    }
  }

  private async runMigration(): Promise<void> {
    // Check if migration already completed (fast path - no locking needed)
    const completed = await this.checkMigrationCompleted();
    if (completed) {
      console.log('[TimeslotMigration] ✓ Already completed, skipping');
      return;
    }

    // Try to acquire distributed lock (prevents concurrent migration runs)
    const lockAcquired = await this.acquireMigrationLock();
    if (!lockAcquired) {
      console.log('[TimeslotMigration] Another instance is running migration, waiting for completion...');
      await this.waitForMigrationCompletion();
      console.log('[TimeslotMigration] ✓ Migration completed by another instance');
      return;
    }

    console.log('[TimeslotMigration] ✓ Acquired migration lock');
    console.log('[TimeslotMigration] Starting time slot adjustment migration...');
    const startTime = Date.now();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // CRITICAL: Clear Redis keys BEFORE migrating database
      // This prevents old-format data from being flushed during/after migration
      console.log('[TimeslotMigration] Step 1: Clearing stale Redis keys...');
      await this.clearRedisStatisticsKeys();
      console.log('[TimeslotMigration] ✓ Redis keys cleared');

      // Start transaction for safety
      await queryRunner.startTransaction();

      // Define tables to migrate
      const tables = [
        'client_statistics_entity',
        'pool_share_statistics_entity',
        'pool_rejected_statistics_entity',
        'client_rejected_statistics_entity',
      ];

      let totalRecords = 0;
      const tableCounts: Record<string, number> = {};

      // Count records in each table
      for (const table of tables) {
        try {
          const countResult = await queryRunner.query(
            `SELECT COUNT(*) as count FROM ${table}`
          );
          const count = parseInt(countResult[0].count);
          tableCounts[table] = count;
          totalRecords += count;
        } catch (error) {
          // Table might not exist yet (fresh install), skip it
          console.log(`[TimeslotMigration] Table ${table} not found, skipping`);
          tableCounts[table] = 0;
        }
      }

      console.log(`[TimeslotMigration] Found ${totalRecords.toLocaleString()} total records across ${tables.length} tables`);
      for (const [table, count] of Object.entries(tableCounts)) {
        if (count > 0) {
          console.log(`[TimeslotMigration]   - ${table}: ${count.toLocaleString()} records`);
        }
      }

      if (totalRecords === 0) {
        console.log('[TimeslotMigration] No records to migrate, marking as complete');
        await this.markMigrationCompleted(queryRunner);
        await queryRunner.commitTransaction();
        return;
      }

      // Calculate cutoff time: only migrate data from last 8 days
      // Older data is not displayed in UI and will eventually be cleaned up
      const DAYS_TO_MIGRATE = 8;
      const cutoffTime = Date.now() - (DAYS_TO_MIGRATE * 24 * 60 * 60 * 1000);
      console.log(`[TimeslotMigration] Only migrating timeslots from last ${DAYS_TO_MIGRATE} days (cutoff: ${new Date(cutoffTime).toISOString()})`);

      // Perform the migration: add 10 minutes to all time values
      // This changes labeling from start-time to end-time
      // IMPORTANT: Update in DESCENDING order to avoid UNIQUE constraint violations
      // Detect database type for correct placeholder syntax
      const databaseType = queryRunner.connection.options.type;

      for (const table of tables) {
        if (tableCounts[table] > 0) {
          console.log(`[TimeslotMigration] Migrating ${table}...`);

          // Get time values from last 8 days in descending order
          let timeValues;
          if (databaseType === 'postgres') {
            timeValues = await queryRunner.query(
              `SELECT DISTINCT time FROM ${table} WHERE time > $1 ORDER BY time DESC`,
              [cutoffTime]
            );
          } else {
            timeValues = await queryRunner.query(
              `SELECT DISTINCT time FROM ${table} WHERE time > ? ORDER BY time DESC`,
              [cutoffTime]
            );
          }

          if (timeValues.length === 0) {
            console.log(`[TimeslotMigration] ⚠️  No recent timeslots to migrate in ${table}`);
            continue;
          }

          // Update each time value individually, starting from highest
          // IMPORTANT: Must include cutoff filter to avoid updating old data with same timestamp
          let updated = 0;
          for (const row of timeValues) {
            const oldTime = row.time;
            const newTime = oldTime + this.TIME_SLOT_DURATION_MS;

            if (databaseType === 'postgres') {
              await queryRunner.query(
                `UPDATE ${table} SET time = $1 WHERE time = $2 AND time > $3`,
                [newTime, oldTime, cutoffTime]
              );
            } else {
              await queryRunner.query(
                `UPDATE ${table} SET time = ? WHERE time = ? AND time > ?`,
                [newTime, oldTime, cutoffTime]
              );
            }
            updated++;
          }

          console.log(`[TimeslotMigration] ✓ Updated ${updated.toLocaleString()} unique time slots in ${table} (out of ${tableCounts[table].toLocaleString()} total)`);
        }
      }

      // Mark migration as completed
      await this.markMigrationCompleted(queryRunner);

      // Commit transaction
      await queryRunner.commitTransaction();

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[TimeslotMigration] ✓ Migration completed successfully in ${duration}s`);
      console.log('[TimeslotMigration] Time slots now use end-time labeling (e.g., "20:50" contains data from 20:40-20:50)');

    } catch (error) {
      // Rollback on error
      await queryRunner.rollbackTransaction();
      console.error('[TimeslotMigration] Migration failed, rolling back:', error);
      throw error;
    } finally {
      await queryRunner.release();
      // Always release the lock, even on error
      await this.releaseMigrationLock();
    }
  }

  /**
   * Clear Redis keys used for pool statistics
   *
   * CRITICAL: This must be called BEFORE migrating the database.
   * Any existing Redis keys use the old time slot format (start-time).
   * We must clear them to prevent old-format keys from being flushed to the
   * freshly migrated database, which would create inconsistent data.
   */
  private async clearRedisStatisticsKeys(): Promise<void> {
    try {
      if (!this.redisClient) {
        console.log('[TimeslotMigration] Redis not available, skipping key cleanup');
        return;
      }

      const redisClient = this.redisClient;
      const patterns = ['pool:rejected:*', 'pool:shares:*', 'pool:mode-hashrate:*'];
      let totalKeysDeleted = 0;

      for (const pattern of patterns) {
        const keys = await redisClient.keys(pattern);
        if (keys && keys.length > 0) {
          console.log(`[TimeslotMigration] Found ${keys.length} stale Redis keys matching "${pattern}"`);
          for (const key of keys) {
            await redisClient.del(key);
            // Also delete any processing locks
            await redisClient.del(`${key}:processing`);
          }
          totalKeysDeleted += keys.length;
        }
      }

      if (totalKeysDeleted > 0) {
        console.log(`[TimeslotMigration] ✓ Cleared ${totalKeysDeleted} stale Redis keys`);
        console.log('[TimeslotMigration] This prevents old time slot format from contaminating migrated data');
      } else {
        console.log('[TimeslotMigration] No stale Redis keys found, cleanup not needed');
      }
    } catch (error) {
      // Redis cleanup failure is CRITICAL - we must not continue
      console.error('[TimeslotMigration] CRITICAL: Failed to clear Redis keys:', error);
      throw new Error('Failed to clear Redis keys before migration - this would cause data corruption');
    }
  }

  /**
   * Acquire distributed lock for migration
   * Uses Redis SET NX EX for atomic lock acquisition
   * Returns true if lock acquired, false if another instance holds the lock
   */
  private async acquireMigrationLock(): Promise<boolean> {
    try {
      if (!this.redisClient) {
        // No Redis - fall back to database-level locking via transactions
        console.log('[TimeslotMigration] Redis not available, using database-level locking');
        return true;
      }

      const redisClient = this.redisClient;
      const instanceId = `node-${process.pid}`;

      // SET key value NX EX seconds - atomic operation
      // NX: Only set if key doesn't exist
      // EX: Set expiry time (auto-release if migration crashes)
      const result = await redisClient.set(
        this.MIGRATION_LOCK_KEY,
        instanceId,
        { NX: true, EX: this.LOCK_TTL_SECONDS },
      );

      return result === 'OK';
    } catch (error) {
      console.error('[TimeslotMigration] Failed to acquire lock:', error);
      // On error, assume we can't acquire lock (safe default)
      return false;
    }
  }

  /**
   * Release migration lock
   */
  private async releaseMigrationLock(): Promise<void> {
    try {
      if (!this.redisClient) {
        return;
      }

      await this.redisClient.del(this.MIGRATION_LOCK_KEY);
      console.log('[TimeslotMigration] ✓ Released migration lock');
    } catch (error) {
      console.warn('[TimeslotMigration] Failed to release lock (non-critical):', error);
    }
  }

  /**
   * Wait for migration to complete (by another instance)
   * Polls the migration completion flag with exponential backoff
   */
  private async waitForMigrationCompletion(): Promise<void> {
    const maxWaitSeconds = this.LOCK_TTL_SECONDS + 60; // Lock TTL + buffer
    const startTime = Date.now();
    let delay = 1000; // Start with 1 second

    while (true) {
      // Check if migration completed
      const completed = await this.checkMigrationCompleted();
      if (completed) {
        return;
      }

      // Check timeout
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > maxWaitSeconds) {
        throw new Error(`Migration did not complete within ${maxWaitSeconds}s - possible deadlock or failure`);
      }

      // Wait with exponential backoff (max 10 seconds)
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 10000);
    }
  }

  /**
   * Check if migration has already been completed
   * Uses a migration tracking table to persist state across restarts
   */
  private async checkMigrationCompleted(): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const databaseType = queryRunner.connection.options.type;

      // Create migrations table if it doesn't exist
      if (databaseType === 'postgres') {
        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            key VARCHAR(255) PRIMARY KEY,
            completed_at BIGINT NOT NULL
          )
        `);
      } else {
        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            key TEXT PRIMARY KEY,
            completed_at INTEGER NOT NULL
          )
        `);
      }

      // Check if our migration key exists
      let result;
      if (databaseType === 'postgres') {
        result = await queryRunner.query(
          'SELECT * FROM migrations WHERE key = $1',
          [this.MIGRATION_KEY]
        );
      } else {
        result = await queryRunner.query(
          'SELECT * FROM migrations WHERE key = ?',
          [this.MIGRATION_KEY]
        );
      }

      return result.length > 0;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Mark migration as completed
   */
  private async markMigrationCompleted(queryRunner): Promise<void> {
    const databaseType = queryRunner.connection.options.type;

    // Ensure migrations table exists
    if (databaseType === 'postgres') {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          key VARCHAR(255) PRIMARY KEY,
          completed_at BIGINT NOT NULL
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          key TEXT PRIMARY KEY,
          completed_at INTEGER NOT NULL
        )
      `);
    }

    // Insert completion record
    if (databaseType === 'postgres') {
      await queryRunner.query(
        'INSERT INTO migrations (key, completed_at) VALUES ($1, $2)',
        [this.MIGRATION_KEY, Date.now()]
      );
    } else {
      await queryRunner.query(
        'INSERT INTO migrations (key, completed_at) VALUES (?, ?)',
        [this.MIGRATION_KEY, Date.now()]
      );
    }
  }
}
