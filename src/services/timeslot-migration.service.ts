import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * - Adds 10 minutes (600000ms) to all time values in client_statistics_entity
 * - Runs once on startup, tracks completion via migration flag file
 * - Safe to run multiple times (idempotent)
 */
@Injectable()
export class TimeslotMigrationService implements OnModuleInit {
  private readonly MIGRATION_KEY = 'TIMESLOT_END_TIME_MIGRATION_COMPLETED';
  private readonly TIME_SLOT_DURATION_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
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

      // Count records before migration
      const countResult = await queryRunner.query(
        'SELECT COUNT(*) as count FROM client_statistics_entity'
      );
      const totalRecords = parseInt(countResult[0].count);
      console.log(`[TimeslotMigration] Found ${totalRecords.toLocaleString()} records to migrate`);

      if (totalRecords === 0) {
        console.log('[TimeslotMigration] No records to migrate, marking as complete');
        await this.markMigrationCompleted(queryRunner);
        await queryRunner.commitTransaction();
        return;
      }

      // Perform the migration: add 10 minutes to all time values
      // This changes labeling from start-time to end-time
      await queryRunner.query(`
        UPDATE client_statistics_entity
        SET time = time + ?
      `, [this.TIME_SLOT_DURATION_MS]);

      console.log(`[TimeslotMigration] ✓ Updated ${totalRecords.toLocaleString()} records`);

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
      throw error;
    } finally {
      await queryRunner.release();
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
