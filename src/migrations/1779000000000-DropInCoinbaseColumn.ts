import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Drops the legacy `inCoinbase` boolean from both history tables.
 *
 *   pplns_payout_history       .inCoinbase   DROP
 *   pplns_group_block_history  .inCoinbase   DROP
 *
 * Why: `rowType` (added in 1777200000000-AddDustSweepColumns) carries
 * strictly more information — `'coinbase' | 'pending' | 'dust-sweep'`
 * vs. just `boolean`. Every writer set both columns in lockstep, so
 * `inCoinbase` was redundant write-only state with drift risk on every
 * new insertion path. UI already consumes `rowType` exclusively;
 * backend code reads neither (verified by grep).
 *
 * Reversible: the down-migration re-adds the column with the original
 * default and reconstructs values from `rowType` (coinbase → true,
 * everything else → false). Sweep audit rows that originated post-drop
 * map to `false`, which matches their pre-drop semantics anyway.
 */
export class DropInCoinbaseColumn1779000000000 implements MigrationInterface {
    name = 'DropInCoinbaseColumn1779000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_payout_history', 'inCoinbase');
        await queryRunner.dropColumn('pplns_group_block_history', 'inCoinbase');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_payout_history',
            new TableColumn({
                name: 'inCoinbase',
                type: 'boolean',
                default: true,
            }),
        );
        await queryRunner.addColumn(
            'pplns_group_block_history',
            new TableColumn({
                name: 'inCoinbase',
                type: 'boolean',
                default: true,
            }),
        );
        await queryRunner.query(`
            UPDATE "pplns_payout_history"
               SET "inCoinbase" = ("rowType" = 'coinbase')
        `);
        await queryRunner.query(`
            UPDATE "pplns_group_block_history"
               SET "inCoinbase" = ("rowType" = 'coinbase')
        `);
    }
}
