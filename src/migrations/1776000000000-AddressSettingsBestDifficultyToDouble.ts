import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * address_settings_entity.bestDifficulty was declared as `real` (32-bit float)
 * which silently truncated precision for large difficulties. The parallel
 * best_difficulty_tracker_entity column stores the same value as
 * `double precision` (64-bit), so every cron tick of the push notification
 * service saw current < tracker and logged a spurious
 * "Difficulty decreased" warning for no actual decrease.
 *
 * Widening the column to double precision aligns both stores and eliminates
 * the precision drift.
 */
export class AddressSettingsBestDifficultyToDouble1776000000000 implements MigrationInterface {
    name = 'AddressSettingsBestDifficultyToDouble1776000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE address_settings_entity
            ALTER COLUMN "bestDifficulty" TYPE double precision
        `);

        console.log('[Migration] address_settings_entity.bestDifficulty: real -> double precision');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE address_settings_entity
            ALTER COLUMN "bestDifficulty" TYPE real
        `);

        console.log('[Migration] address_settings_entity.bestDifficulty: double precision -> real');
    }
}
