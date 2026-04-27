import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Idempotency defense-in-depth for block-payout bookkeeping.
 *
 * onBlockFound writes history rows from a Redis-persisted snapshot. A crash
 * between the `save(history)` call and the subsequent `markPaid(balance)`
 * call would leave bookkeeping inconsistent. To make the whole operation
 * safe to replay, we:
 *
 *   1. Wrap history-insert + balance-update in one Postgres transaction per
 *      (block, address) pair (application code change).
 *   2. Enforce uniqueness at the DB layer so a replay can INSERT ... ON
 *      CONFLICT DO NOTHING and the transaction's RETURNING clause tells the
 *      app whether the row was actually written this run (so it knows
 *      whether to also do the balance update).
 *
 * This migration is step (2): add unique indexes on
 *
 *   - pplns_payout_history          (blockHeight, address)
 *   - pplns_group_block_history     (groupId, blockHeight, address)
 *
 * Before creating the index, dedupe any pre-existing duplicates (keep the
 * earliest-inserted row — lowest primary-key id). Prior versions of the
 * service did not guard against double-insert on restart, so a prod DB may
 * carry a handful of duplicate rows from real outages.
 */
export class AddPayoutHistoryUniqueConstraints1776800000000 implements MigrationInterface {
    name = 'AddPayoutHistoryUniqueConstraints1776800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // pplns_payout_history: dedupe on (blockHeight, address).
        await queryRunner.query(`
            DELETE FROM "pplns_payout_history"
            WHERE "id" NOT IN (
                SELECT MIN("id")
                FROM "pplns_payout_history"
                GROUP BY "blockHeight", "address"
            )
        `);

        const payoutTable = await queryRunner.getTable('pplns_payout_history');
        if (payoutTable && !payoutTable.indices.find(i => i.name === 'UQ_pplns_payout_history_block_address')) {
            await queryRunner.createIndex(
                'pplns_payout_history',
                new TableIndex({
                    name: 'UQ_pplns_payout_history_block_address',
                    columnNames: ['blockHeight', 'address'],
                    isUnique: true,
                }),
            );
        }

        // pplns_group_block_history: dedupe on (groupId, blockHeight, address).
        await queryRunner.query(`
            DELETE FROM "pplns_group_block_history"
            WHERE "id" NOT IN (
                SELECT MIN("id")
                FROM "pplns_group_block_history"
                GROUP BY "groupId", "blockHeight", "address"
            )
        `);

        const groupTable = await queryRunner.getTable('pplns_group_block_history');
        if (groupTable && !groupTable.indices.find(i => i.name === 'UQ_pplns_group_block_history_group_block_address')) {
            await queryRunner.createIndex(
                'pplns_group_block_history',
                new TableIndex({
                    name: 'UQ_pplns_group_block_history_group_block_address',
                    columnNames: ['groupId', 'blockHeight', 'address'],
                    isUnique: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const groupTable = await queryRunner.getTable('pplns_group_block_history');
        if (groupTable && groupTable.indices.find(i => i.name === 'UQ_pplns_group_block_history_group_block_address')) {
            await queryRunner.dropIndex('pplns_group_block_history', 'UQ_pplns_group_block_history_group_block_address');
        }

        const payoutTable = await queryRunner.getTable('pplns_payout_history');
        if (payoutTable && payoutTable.indices.find(i => i.name === 'UQ_pplns_payout_history_block_address')) {
            await queryRunner.dropIndex('pplns_payout_history', 'UQ_pplns_payout_history_block_address');
        }
    }
}
