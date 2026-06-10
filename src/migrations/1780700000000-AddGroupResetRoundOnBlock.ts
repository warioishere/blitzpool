import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `resetRoundOnBlock` to `pplns_group`. When true, the Group-Solo round
 * (share window) is wiped on every block-found. Default false: shares
 * accumulate across blocks until a calendar preset or manual reset fires.
 * Existing rows backfill to false (the prior behaviour was an unconditional
 * per-block wipe, but accumulate is the safer new default — opt in per group
 * via PATCH /pplns/groups/:id/settings). Per-finder coinbase snapshots are
 * always dropped on block-found regardless of this flag.
 */
export class AddGroupResetRoundOnBlock1780700000000 implements MigrationInterface {
    name = 'AddGroupResetRoundOnBlock1780700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'pplns_group',
            new TableColumn({
                name: 'resetRoundOnBlock',
                type: 'boolean',
                isNullable: false,
                default: false,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('pplns_group', 'resetRoundOnBlock');
    }
}
