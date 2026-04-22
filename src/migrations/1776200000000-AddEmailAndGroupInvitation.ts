import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Tables for the email-required payout-group invitation flow:
 *   pplns_address_email      — verified address↔email bindings
 *   pplns_email_verification — pending email-verify tokens (24h TTL)
 *   pplns_group_invitation   — pending group invitations (7d TTL)
 */
export class AddEmailAndGroupInvitation1776200000000 implements MigrationInterface {
    name = 'AddEmailAndGroupInvitation1776200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── pplns_address_email ───────────────────────────────────────
        await queryRunner.createTable(
            new Table({
                name: 'pplns_address_email',
                columns: [
                    { name: 'address', type: 'varchar', length: '62', isPrimary: true },
                    { name: 'email', type: 'varchar', length: '320' },
                    { name: 'verifiedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        // ── pplns_email_verification ──────────────────────────────────
        await queryRunner.createTable(
            new Table({
                name: 'pplns_email_verification',
                columns: [
                    { name: 'token', type: 'varchar', length: '64', isPrimary: true },
                    { name: 'address', type: 'varchar', length: '62' },
                    { name: 'email', type: 'varchar', length: '320' },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'expiresAt', type: 'timestamp' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_email_verification',
            new TableIndex({ columnNames: ['address'] }),
        );

        // ── pplns_group_invitation ────────────────────────────────────
        await queryRunner.createTable(
            new Table({
                name: 'pplns_group_invitation',
                columns: [
                    { name: 'token', type: 'varchar', length: '64', isPrimary: true },
                    { name: 'groupId', type: 'varchar', length: '36' },
                    { name: 'address', type: 'varchar', length: '62' },
                    { name: 'email', type: 'varchar', length: '320' },
                    { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'expiresAt', type: 'timestamp' },
                    { name: 'respondedAt', type: 'timestamp', isNullable: true },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'pplns_group_invitation',
            new TableIndex({ columnNames: ['groupId'] }),
        );

        await queryRunner.createIndex(
            'pplns_group_invitation',
            new TableIndex({ columnNames: ['address'] }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('pplns_group_invitation', true);
        await queryRunner.dropTable('pplns_email_verification', true);
        await queryRunner.dropTable('pplns_address_email', true);
    }
}
