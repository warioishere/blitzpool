import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Columns needed to drive the dust-sweep cron:
 *
 *   pplns_balance             .last_accepted_share_at  TIMESTAMPTZ NULL
 *   pplns_group_balance       .last_accepted_share_at  TIMESTAMPTZ NULL
 *
 * And row-type discriminators so the dust-sweep audit trail is
 * distinguishable from ordinary coinbase / pending rows:
 *
 *   pplns_payout_history        .row_type   VARCHAR(16) DEFAULT 'coinbase'
 *   pplns_group_block_history   .row_type   VARCHAR(16) DEFAULT 'coinbase'
 *
 * Backfill for row_type:
 *   - existing rows with inCoinbase = true  → 'coinbase'
 *   - existing rows with inCoinbase = false → 'pending'
 *   - future rows from the sweep path use 'dust-sweep'
 *
 * lastAcceptedShareAt backfill: left NULL. Existing pending balances are
 * safe from the sweep because the cron treats NULL as "no signal, don't
 * sweep" (see DustSweepService.sweep()). They'll get a timestamp on the
 * miner's next accepted share, or stay put until explicit operator
 * intervention.
 */
export class AddDustSweepColumns1777200000000 implements MigrationInterface {
    name = 'AddDustSweepColumns1777200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_balance',
            new TableColumn({
                name: 'lastAcceptedShareAt',
                type: 'timestamptz',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_group_balance',
            new TableColumn({
                name: 'lastAcceptedShareAt',
                type: 'timestamptz',
                isNullable: true,
            }),
        );

        await queryRunner.addColumn(
            'pplns_payout_history',
            new TableColumn({
                name: 'rowType',
                type: 'varchar',
                length: '16',
                default: "'coinbase'",
            }),
        );

        await queryRunner.addColumn(
            'pplns_group_block_history',
            new TableColumn({
                name: 'rowType',
                type: 'varchar',
                length: '16',
                default: "'coinbase'",
            }),
        );

        // Backfill rowType from the existing inCoinbase discriminator.
        await queryRunner.query(`
            UPDATE "pplns_payout_history"
               SET "rowType" = CASE WHEN "inCoinbase" THEN 'coinbase' ELSE 'pending' END
        `);
        await queryRunner.query(`
            UPDATE "pplns_group_block_history"
               SET "rowType" = CASE WHEN "inCoinbase" THEN 'coinbase' ELSE 'pending' END
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group_block_history', 'rowType');
        await queryRunner.dropColumn('pplns_payout_history', 'rowType');
        await queryRunner.dropColumn('pplns_group_balance', 'lastAcceptedShareAt');
        await queryRunner.dropColumn('pplns_balance', 'lastAcceptedShareAt');
    }
}
