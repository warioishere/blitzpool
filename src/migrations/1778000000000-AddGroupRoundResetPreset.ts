import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the `roundResetPreset` column to `pplns_group`. The preset is
 * the authoritative cadence selector for scheduled round-resets:
 *
 *   'daily'   — every day at 00:00 in admin's TZ
 *   'weekly'  — every Monday at 00:00 in admin's TZ
 *   'monthly' — 1st of every month at 00:00 in admin's TZ
 *   'custom'  — every `roundResetIntervalDays` days at 00:00 in TZ
 *   NULL      — no scheduled reset
 *
 * Existing groups (created before this column existed) keep their
 * `roundResetIntervalDays` value; the service treats them as 'custom'
 * when the preset is NULL but the interval is set.
 */
export class AddGroupRoundResetPreset1778000000000 implements MigrationInterface {
    name = 'AddGroupRoundResetPreset1778000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'roundResetPreset',
                type: 'varchar',
                length: '16',
                isNullable: true,
            }),
        );

        // Backfill: any group with an interval already configured but
        // no preset becomes 'custom' so its cadence semantics don't
        // change silently when the new code starts reading the preset.
        await queryRunner.query(`
            UPDATE pplns_group
               SET "roundResetPreset" = 'custom'
             WHERE "roundResetPreset" IS NULL
               AND "roundResetIntervalDays" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group', 'roundResetPreset');
    }
}
