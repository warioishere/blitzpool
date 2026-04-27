import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zeroes out any negative `pplns_group_balance.pendingSats` left over from
 * the brief window between the v2.1.0 coinbase-distribution refactor and
 * the C2 fix.
 *
 * Background: the refactor routed Group-Solo's payout path through the
 * shared `buildCoinbaseDistribution`, which produces signed balances
 * (Phase 5a bonus recipients get debits, Phase 5b residuum recipients
 * get debits). Those signed values were written verbatim to
 * `pplns_group_balance.pendingSats`, a column whose semantics have always
 * been "non-negative amount the pool owes the member for this group".
 *
 * The dust-sweep cron filters `pendingSats > 0 AND pendingSats < :dust`
 * so negatives never get cleaned up. Member-kick redistribution only
 * acts on positive pending. These rows would accumulate indefinitely.
 *
 * The fix for C2 passes `suppressMatchingDebits: true` into the shared
 * engine when called from Group-Solo, so no new negatives get created.
 * This migration cleans up rows created during the transition: the
 * matching credit-holders are not recoverable (the pool-neutral pair was
 * recorded in snapshot history at the time, not as a standing relation),
 * so the clean cut is to zero them. Lifetime `totalPaidSats` stays intact
 * so member dashboards don't lose payout history.
 *
 * Safe to run even on a fresh database (nothing matches the WHERE).
 */
export class ClearNegativeGroupSoloBalances1777600000000 implements MigrationInterface {
    name = 'ClearNegativeGroupSoloBalances1777600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('pplns_group_balance');
        if (!table) return;
        await queryRunner.query(
            `UPDATE "pplns_group_balance" SET "pendingSats" = 0 WHERE "pendingSats" < 0`,
        );
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // No-op: we cannot reconstruct the per-member signed values we
        // discarded on up(). A rollback simply leaves the balances at 0,
        // which is a safe operating state on any prior code version.
    }
}
