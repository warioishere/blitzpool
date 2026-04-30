import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds open-invitation support to `pplns_group_invitation`:
 *   - `address` becomes nullable (open invites have no pre-bound address)
 *   - `email` becomes nullable (open invites have no pre-bound email)
 *   - `inviteType` enum-string column, default 'directed'
 *
 * Existing rows are unaffected — they keep their (address, email) values
 * and get `inviteType='directed'` from the column default. Open invites
 * (inviteType='open') store nothing about the invitee at create time;
 * they get bound to a specific address only at accept time, and the
 * single row stays usable until TTL expires (or until manually revoked).
 *
 * Status semantics now also recognise 'revoked' for open invites that
 * were superseded by a new open-invite or explicitly revoked by the
 * admin. The varchar column doesn't enforce the enum so this is a
 * pure code-level change.
 */
export class AddOpenInvitationSupport1779600000000 implements MigrationInterface {
    name = 'AddOpenInvitationSupport1779600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pplns_group_invitation" ALTER COLUMN "address" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "pplns_group_invitation" ALTER COLUMN "email" DROP NOT NULL`);
        await queryRunner.addColumn(
            'pplns_group_invitation',
            new TableColumn({
                name: 'inviteType',
                type: 'varchar',
                length: '16',
                default: `'directed'`,
                isNullable: false,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group_invitation', 'inviteType');
        // Note: the down does NOT re-add NOT NULL constraints. Doing so
        // would fail if any open-invitation rows exist (they have NULL
        // address/email). Manual cleanup required if you need to revert
        // the nullability change.
    }
}
