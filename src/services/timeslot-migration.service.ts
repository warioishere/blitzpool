import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DataSource } from 'typeorm';

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
 * - Adds 10 minutes (600000ms) to all time values in:
 *   - client_statistics_entity
 *   - pool_share_statistics_entity
 *   - pool_rejected_statistics_entity
 *   - client_rejected_statistics_entity
 * - Clears stale Redis keys (pool:rejected:*, pool:shares:*) to prevent conflicts
 * - Runs once on startup, tracks completion via migration flag file
 * - Safe to run multiple times (idempotent)
 */
@Injectable()
export class TimeslotMigrationService implements OnModuleInit {
  private readonly MIGRATION_KEY = 'TIMESLOT_END_TIME_MIGRATION_V2_COMPLETED';
  private readonly TIME_SLOT_DURATION_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
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
    // Check if migration already completed
    const completed = await this.checkMigrationCompleted();
    if (completed) {
      console.log('[TimeslotMigration] ✓ Already completed, skipping');
      return;
    }

    console.log('[TimeslotMigration] Starting time slot adjustment migration...');
    const startTime = Date.now();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
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

      // Perform the migration: add 10 minutes to all time values
      // This changes labeling from start-time to end-time
      for (const table of tables) {
        if (tableCounts[table] > 0) {
          console.log(`[TimeslotMigration] Migrating ${table}...`);
          await queryRunner.query(`
            UPDATE ${table}
            SET time = time + ?
          `, [this.TIME_SLOT_DURATION_MS]);
          console.log(`[TimeslotMigration] ✓ Updated ${tableCounts[table].toLocaleString()} records in ${table}`);
        }
      }

      // Mark migration as completed
      await this.markMigrationCompleted(queryRunner);

      // Commit transaction
      await queryRunner.commitTransaction();

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[TimeslotMigration] ✓ Migration completed successfully in ${duration}s`);
      console.log('[TimeslotMigration] Time slots now use end-time labeling (e.g., "20:50" contains data from 20:40-20:50)');

      // Clear Redis statistics keys to prevent stale old-format keys from being flushed
      await this.clearRedisStatisticsKeys();

    } catch (error) {
      // Rollback on error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Clear Redis keys used for pool statistics
   *
   * After migration, any existing Redis keys use the old time slot format.
   * We must clear them to prevent old-format keys from being flushed to the
   * freshly migrated database, which would create inconsistent data.
   */
  private async clearRedisStatisticsKeys(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (!store || !store.client) {
        console.log('[TimeslotMigration] Redis not available, skipping key cleanup');
        return;
      }

      const redisClient = store.client;
      const patterns = ['pool:rejected:*', 'pool:shares:*'];
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
      // Don't fail the migration if Redis cleanup fails
      console.warn('[TimeslotMigration] Failed to clear Redis keys (non-critical):', error);
      console.warn('[TimeslotMigration] You may want to manually clear pool:rejected:* and pool:shares:* keys');
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
      // Create migrations table if it doesn't exist
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          key TEXT PRIMARY KEY,
          completed_at INTEGER NOT NULL
        )
      `);

      // Check if our migration key exists
      const result = await queryRunner.query(
        'SELECT * FROM migrations WHERE key = ?',
        [this.MIGRATION_KEY]
      );

      return result.length > 0;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Mark migration as completed
   */
  private async markMigrationCompleted(queryRunner): Promise<void> {
    // Ensure migrations table exists
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        key TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      )
    `);

    // Insert completion record
    await queryRunner.query(
      'INSERT INTO migrations (key, completed_at) VALUES (?, ?)',
      [this.MIGRATION_KEY, Date.now()]
    );
  }
}
