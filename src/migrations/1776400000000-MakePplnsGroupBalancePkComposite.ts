import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `pplns_group_balance` primary key from `address` to the composite
 * `(address, groupId)`.
 *
 * Before the change, a miner moving between groups over time would mutate a
 * single row (keyed by address alone) with whichever `groupId` happened to
 * be written last by the application code. That coupled pending-balance
 * rows across unrelated groups and caused sats earned in group B to be
 * paid out from group A's next block.
 *
 * The composite key lets every (address, groupId) historical pairing keep
 * its own row. At any one point in time a miner is a member of at most one
 * group (enforced by the global unique index on pplns_group_member.address),
 * so no single-point-in-time duplicates can occur — the migration can run
 * on live data without a dedup step.
 */
export class MakePplnsGroupBalancePkComposite1776400000000 implements MigrationInterface {
    name = 'MakePplnsGroupBalancePkComposite1776400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('pplns_group_balance');
        if (!table) return;

        if (table.primaryColumns.length === 1 && table.primaryColumns[0].name === 'address') {
            // Drop the single-column PK. TypeORM's dropPrimaryKey wants the
            // current primary column names.
            await queryRunner.dropPrimaryKey('pplns_group_balance');
        }

        // Re-create as composite. createPrimaryKey is idempotent-friendly:
        // it just issues the ALTER TABLE ADD PRIMARY KEY.
        await queryRunner.createPrimaryKey('pplns_group_balance', ['address', 'groupId']);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('pplns_group_balance');
        if (!table) return;

        if (table.primaryColumns.length > 0) {
            await queryRunner.dropPrimaryKey('pplns_group_balance');
        }
        await queryRunner.createPrimaryKey('pplns_group_balance', ['address']);
    }
}
