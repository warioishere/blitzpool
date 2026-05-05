import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `approvalRequired` flag to `pplns_group_invitation`. When true on
 * an open invite, the public accept endpoint refuses to auto-add the
 * miner — the joiner has to go through the join-request flow instead so
 * the admin can vet each applicant. Defaults to false to preserve the
 * existing auto-accept behaviour for links generated before this column
 * existed.
 *
 * Only meaningful for inviteType='open'. Directed invites already imply
 * the admin has hand-picked the address; the column is left at false on
 * those rows and ignored by the directed accept path.
 */
export class AddOpenInvitationApprovalRequired1780000000000 implements MigrationInterface {
    name = 'AddOpenInvitationApprovalRequired1780000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group_invitation',
            new TableColumn({
                name: 'approvalRequired',
                type: 'boolean',
                default: false,
                isNullable: false,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group_invitation', 'approvalRequired');
    }
}
