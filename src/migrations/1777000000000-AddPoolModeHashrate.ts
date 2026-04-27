import { MigrationInterface, QueryRunner, Table, TableIndex, TableUnique } from 'typeorm';

/**
 * Per-mode pool-wide hashrate aggregates. Enables splash-page + analytics
 * "Solo vs PPLNS vs Group-Solo" curves without re-deriving from
 * PPLNS-window state (which lags by hours after a port switch).
 *
 * Created empty — historical shares can't be retroactively mode-tagged.
 * Data fills in from the first share after deployment.
 */
export class AddPoolModeHashrate1777000000000 implements MigrationInterface {
    name = 'AddPoolModeHashrate1777000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'pool_mode_hashrate',
                columns: [
                    { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
                    { name: 'mode', type: 'varchar', length: '16' },
                    { name: 'time', type: 'bigint' },
                    { name: 'diff', type: 'real', default: 0 },
                ],
            }),
            true,
        );

        await queryRunner.createUniqueConstraint(
            'pool_mode_hashrate',
            new TableUnique({
                name: 'UQ_pool_mode_hashrate_mode_time',
                columnNames: ['mode', 'time'],
            }),
        );

        await queryRunner.createIndex(
            'pool_mode_hashrate',
            new TableIndex({
                name: 'IDX_pool_mode_hashrate_mode',
                columnNames: ['mode'],
            }),
        );

        await queryRunner.createIndex(
            'pool_mode_hashrate',
            new TableIndex({
                name: 'IDX_pool_mode_hashrate_time',
                columnNames: ['time'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('pool_mode_hashrate');
    }
}
