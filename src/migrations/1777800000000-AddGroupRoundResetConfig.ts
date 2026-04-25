import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Group-solo timed-reset + finder-bonus configuration.
 *
 * Adds five columns to `pplns_group`:
 *
 *   roundResetIntervalDays  INT NULL                 — days between scheduled resets, NULL = off
 *   roundResetHourLocal     INT NULL                 — hour-of-day 0-23 in the group's TZ
 *   roundResetTimezone      VARCHAR(64) NULL         — IANA zone (e.g. 'Europe/Berlin')
 *   lastRoundResetAt        TIMESTAMPTZ NULL         — last successful scheduled-reset firing
 *   finderBonusSats         BIGINT NULL              — absolute sats bonus to the block finder
 *
 * All columns are nullable and default to NULL — existing groups
 * keep their original behaviour (only block-found resets the round,
 * no finder bonus). An admin opts the group in via
 * PATCH /pplns/groups/:id/settings.
 */
export class AddGroupRoundResetConfig1777800000000 implements MigrationInterface {
    name = 'AddGroupRoundResetConfig1777800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'roundResetIntervalDays',
                type: 'int',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'roundResetHourLocal',
                type: 'int',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'roundResetTimezone',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'lastRoundResetAt',
                type: 'timestamptz',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'finderBonusSats',
                type: 'bigint',
                isNullable: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group', 'finderBonusSats');
        await queryRunner.dropColumn('pplns_group', 'lastRoundResetAt');
        await queryRunner.dropColumn('pplns_group', 'roundResetTimezone');
        await queryRunner.dropColumn('pplns_group', 'roundResetHourLocal');
        await queryRunner.dropColumn('pplns_group', 'roundResetIntervalDays');
    }
}
