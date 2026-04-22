import { MigrationInterface, QueryRunner, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Adds database-level referential integrity to the payout-group tables
 * and speed-up indexes for the expiry-sweep cron.
 *
 * H4 (foreign keys): prior migrations created pplns_group_member,
 * pplns_group_balance, pplns_group_block_history and pplns_group_invitation
 * with a `groupId` column but no FK constraint. Deletion was app-enforced,
 * which works today but leaves every future code path one forgotten
 * cascade-delete away from orphans. With ON DELETE CASCADE the database
 * guarantees children go when their group goes, regardless of which code
 * path initiated the dissolve.
 *
 * H5 (expiresAt indexes): the hourly expiry-sweep cron filters by
 * `expiresAt < NOW()`. Without an index that's a full scan on tables
 * that grow linearly with invitation/verification volume.
 */
export class AddPplnsGroupForeignKeysAndExpiryIndexes1776600000000 implements MigrationInterface {
    name = 'AddPplnsGroupForeignKeysAndExpiryIndexes1776600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // pplns_group_invitation.groupId was originally created as varchar(36)
        // while pplns_group.id is uuid. Postgres refuses to FK across
        // non-identical types, so convert the column first. The cast is
        // safe because the only writer is GroupService.createGroup which
        // always uses crypto.randomUUID().
        await queryRunner.query(
            `ALTER TABLE "pplns_group_invitation" ALTER COLUMN "groupId" TYPE uuid USING "groupId"::uuid`,
        );

        const addGroupFk = async (tableName: string) => {
            const table = await queryRunner.getTable(tableName);
            if (!table) return;
            const already = table.foreignKeys.find(fk =>
                fk.columnNames.length === 1
                && fk.columnNames[0] === 'groupId'
                && fk.referencedTableName === 'pplns_group',
            );
            if (already) return;
            await queryRunner.createForeignKey(
                tableName,
                new TableForeignKey({
                    columnNames: ['groupId'],
                    referencedColumnNames: ['id'],
                    referencedTableName: 'pplns_group',
                    onDelete: 'CASCADE',
                }),
            );
        };

        await addGroupFk('pplns_group_member');
        await addGroupFk('pplns_group_balance');
        await addGroupFk('pplns_group_block_history');
        await addGroupFk('pplns_group_invitation');

        const addIndex = async (tableName: string, columnName: string, name: string) => {
            const table = await queryRunner.getTable(tableName);
            if (!table) return;
            const already = table.indices.find(i => i.columnNames.length === 1 && i.columnNames[0] === columnName);
            if (already) return;
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name, columnNames: [columnName] }),
            );
        };

        await addIndex('pplns_group_invitation', 'expiresAt', 'IDX_pplns_group_invitation_expiresAt');
        await addIndex('pplns_email_verification', 'expiresAt', 'IDX_pplns_email_verification_expiresAt');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dropGroupFk = async (tableName: string) => {
            const table = await queryRunner.getTable(tableName);
            if (!table) return;
            const fk = table.foreignKeys.find(f =>
                f.columnNames.length === 1
                && f.columnNames[0] === 'groupId'
                && f.referencedTableName === 'pplns_group',
            );
            if (fk) await queryRunner.dropForeignKey(tableName, fk);
        };

        await dropGroupFk('pplns_group_invitation');
        await dropGroupFk('pplns_group_block_history');
        await dropGroupFk('pplns_group_balance');
        await dropGroupFk('pplns_group_member');

        const dropIndex = async (tableName: string, name: string) => {
            const table = await queryRunner.getTable(tableName);
            if (!table) return;
            if (table.indices.find(i => i.name === name)) {
                await queryRunner.dropIndex(tableName, name);
            }
        };

        await dropIndex('pplns_email_verification', 'IDX_pplns_email_verification_expiresAt');
        await dropIndex('pplns_group_invitation', 'IDX_pplns_group_invitation_expiresAt');

        // Cast the invitation.groupId column back to varchar(36) to match
        // the pre-migration schema.
        await queryRunner.query(
            `ALTER TABLE "pplns_group_invitation" ALTER COLUMN "groupId" TYPE varchar(36) USING "groupId"::text`,
        );
    }
}
