import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddPplnsGroup1776000000000 implements MigrationInterface {
    name = 'AddPplnsGroup1776000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'pplns_group',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'name', type: 'varchar', length: '64', isUnique: true },
                    { name: 'creatorAddress', type: 'varchar', length: '62' },
                    { name: 'adminTokenHash', type: 'varchar', length: '255' },
                    { name: 'active', type: 'boolean', default: false },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'dissolvedAt', type: 'timestamp', isNullable: true },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'pplns_group_member',
                columns: [
                    { name: 'id', type: 'integer', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
                    { name: 'groupId', type: 'uuid' },
                    { name: 'address', type: 'varchar', length: '62', isUnique: true },
                    { name: 'role', type: 'varchar', length: '16', default: "'member'" },
                    { name: 'joinedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_group_member',
            new TableIndex({ columnNames: ['groupId'] }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'pplns_group_block_history',
                columns: [
                    { name: 'id', type: 'integer', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
                    { name: 'groupId', type: 'uuid' },
                    { name: 'blockHeight', type: 'int' },
                    { name: 'address', type: 'varchar', length: '62' },
                    { name: 'paidSats', type: 'bigint', default: '0' },
                    { name: 'percent', type: 'real', default: '0' },
                    { name: 'sharesInRound', type: 'bigint', default: '0' },
                    { name: 'totalSharesInRound', type: 'bigint', default: '0' },
                    { name: 'inCoinbase', type: 'boolean', default: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_group_block_history',
            new TableIndex({ columnNames: ['groupId'] }),
        );

        await queryRunner.createIndex(
            'pplns_group_block_history',
            new TableIndex({ columnNames: ['blockHeight'] }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'pplns_group_balance',
                columns: [
                    { name: 'address', type: 'varchar', length: '62', isPrimary: true },
                    { name: 'groupId', type: 'uuid' },
                    { name: 'pendingSats', type: 'bigint', default: '0' },
                    { name: 'totalPaidSats', type: 'bigint', default: '0' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_group_balance',
            new TableIndex({ columnNames: ['groupId'] }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('pplns_group_balance', true);
        await queryRunner.dropTable('pplns_group_block_history', true);
        await queryRunner.dropTable('pplns_group_member', true);
        await queryRunner.dropTable('pplns_group', true);
    }
}
