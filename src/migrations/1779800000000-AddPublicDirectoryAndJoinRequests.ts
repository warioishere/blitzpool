import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Adds the `pplns_group_join_request` table — user-initiated requests to
 * join a public group. Lifecycle: pending → approved | rejected | expired.
 *
 * The unique partial index `(groupId, address)` WHERE status='pending'
 * enforces the "1 pending per (address, group)" rate limit at DB level so
 * concurrent requests can't slip through. Other rate limits (max-pending
 * per address globally, post-reject cooldown) are enforced in the service.
 */
export class AddPublicDirectoryAndJoinRequests1779800000000 implements MigrationInterface {
    name = 'AddPublicDirectoryAndJoinRequests1779800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(new Table({
            name: 'pplns_group_join_request',
            columns: [
                { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
                { name: 'groupId', type: 'uuid', isNullable: false },
                { name: 'address', type: 'varchar', length: '62', isNullable: false },
                { name: 'email', type: 'varchar', length: '320', isNullable: false },
                { name: 'message', type: 'text', isNullable: true },
                { name: 'status', type: 'varchar', length: '16', default: `'pending'`, isNullable: false },
                { name: 'createdAt', type: 'timestamptz', default: 'now()', isNullable: false },
                { name: 'decidedAt', type: 'timestamptz', isNullable: true },
                // Audit trail for admin decisions. Stored as the SHA-256 hash
                // (already how admin tokens are stored on the group) so a DB
                // dump never reveals raw tokens.
                { name: 'decidedByAdminTokenHash', type: 'varchar', length: '255', isNullable: true },
            ],
        }), true);

        await queryRunner.createIndex('pplns_group_join_request', new TableIndex({
            name: 'IDX_pplns_join_request_group_status',
            columnNames: ['groupId', 'status'],
        }));

        await queryRunner.createIndex('pplns_group_join_request', new TableIndex({
            name: 'IDX_pplns_join_request_address_status',
            columnNames: ['address', 'status'],
        }));

        // Unique partial index: at most one pending request per (group, address).
        // TypeORM doesn't directly model partial indexes — go via raw SQL.
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_pplns_join_request_group_address_pending"
            ON "pplns_group_join_request" ("groupId", "address")
            WHERE "status" = 'pending'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pplns_join_request_group_address_pending"`);
        await queryRunner.dropIndex('pplns_group_join_request', 'IDX_pplns_join_request_address_status');
        await queryRunner.dropIndex('pplns_group_join_request', 'IDX_pplns_join_request_group_status');
        await queryRunner.dropTable('pplns_group_join_request', true);
    }
}
