import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `isPublic` to `pplns_group`. When true, the group surfaces in the
 * public group directory (`GET /pplns/groups/public`) and accepts
 * unsolicited join-requests via the public-listing flow. Default false
 * for backward compatibility — existing groups stay private until the
 * admin opts in.
 */
export class AddGroupIsPublic1779400000000 implements MigrationInterface {
    name = 'AddGroupIsPublic1779400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'isPublic',
                type: 'boolean',
                default: false,
                isNullable: false,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group', 'isPublic');
    }
}
