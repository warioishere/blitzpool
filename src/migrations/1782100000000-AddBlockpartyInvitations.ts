import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Per-member directed invitation table for Blockparty groups. One row
 * per outstanding invite — token is the primary key (bearer-token model,
 * same as pplns_group_invitation).
 */
export class AddBlockpartyInvitations1782100000000 implements MigrationInterface {
    name = 'AddBlockpartyInvitations1782100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const BIGINT_NOW_MS = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

        await queryRunner.createTable(new Table({
            name: 'blockparty_invitation',
            columns: [
                { name: 'token', type: 'varchar', length: '64', isPrimary: true },
                { name: 'groupId', type: 'uuid', isNullable: false },
                { name: 'address', type: 'varchar', length: '62', isNullable: false },
                { name: 'email', type: 'varchar', length: '320', isNullable: false },
                { name: 'status', type: 'varchar', length: '16', default: `'pending'`, isNullable: false },
                { name: 'createdAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
                { name: 'expiresAt', type: 'bigint', isNullable: false },
                { name: 'respondedAt', type: 'bigint', isNullable: true },
            ],
            foreignKeys: [
                new TableForeignKey({
                    name: 'FK_blockparty_invitation_group',
                    columnNames: ['groupId'],
                    referencedTableName: 'blockparty_group',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            ],
        }), true);

        await queryRunner.createIndex('blockparty_invitation', new TableIndex({
            name: 'IDX_blockparty_invitation_group',
            columnNames: ['groupId'],
        }));

        await queryRunner.createIndex('blockparty_invitation', new TableIndex({
            name: 'IDX_blockparty_invitation_address',
            columnNames: ['address'],
        }));

        // Partial unique index: at most one pending invitation per (group, address).
        // Re-issuing a token for the same address requires the prior row to
        // transition out of 'pending' first (decline/accept/expire/revoke).
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_blockparty_invitation_group_address_pending"
            ON "blockparty_invitation" ("groupId", "address")
            WHERE "status" = 'pending'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_blockparty_invitation_group_address_pending"`);
        await queryRunner.dropTable('blockparty_invitation', true);
    }
}
