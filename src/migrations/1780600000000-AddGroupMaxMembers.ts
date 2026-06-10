import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `maxMembers` to `pplns_group`. When set (non-NULL), the group is
 * capped at that many members and every add-member path (directed invite,
 * open invite link, approved join request) is rejected once the cap is
 * reached. NULL = no limit (existing behaviour). Enforced server-side at
 * the single `GroupService.addMemberWithoutAdmin` chokepoint.
 */
export class AddGroupMaxMembers1780600000000 implements MigrationInterface {
    name = 'AddGroupMaxMembers1780600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'maxMembers',
                type: 'int',
                isNullable: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group', 'maxMembers');
    }
}
