import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddPplnsBalance1769980000000 implements MigrationInterface {
    name = 'AddPplnsBalance1769980000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'pplns_balance',
                columns: [
                    {
                        name: 'address',
                        type: 'varchar',
                        length: '62',
                        isPrimary: true,
                    },
                    {
                        name: 'pendingSats',
                        type: 'bigint',
                        default: '0',
                    },
                    {
                        name: 'totalPaidSats',
                        type: 'bigint',
                        default: '0',
                    },
                    {
                        name: 'updatedAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'pplns_payout_history',
                columns: [
                    {
                        name: 'id',
                        type: 'integer',
                        isPrimary: true,
                        isGenerated: true,
                        generationStrategy: 'increment',
                    },
                    {
                        name: 'blockHeight',
                        type: 'int',
                    },
                    {
                        name: 'address',
                        type: 'varchar',
                        length: '62',
                    },
                    {
                        name: 'paidSats',
                        type: 'bigint',
                        default: '0',
                    },
                    {
                        name: 'percent',
                        type: 'real',
                        default: '0',
                    },
                    {
                        name: 'inCoinbase',
                        type: 'boolean',
                        default: true,
                    },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_payout_history',
            new TableIndex({ columnNames: ['address'] }),
        );

        await queryRunner.createIndex(
            'pplns_payout_history',
            new TableIndex({ columnNames: ['blockHeight'] }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('pplns_payout_history', true);
        await queryRunner.dropTable('pplns_balance', true);
    }
}
