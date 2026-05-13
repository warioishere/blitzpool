import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restore `DEFAULT` clauses on the timestamp columns that
 * TrackedEntityTimestampsToBigint1781400000000 dropped. The DROP was
 * intended because the BeforeInsert TypeORM subscriber would fill the
 * values on entity-instance writes — but raw `INSERT ... SELECT FROM
 * unnest(...)` paths in StatisticsCoordinator + ClientStatisticsService
 * don't trigger subscribers and so left createdAt NULL after the bigint
 * conversion.
 *
 * Fix: re-add a column default that emits epoch-ms via the standard
 * Postgres `EXTRACT(EPOCH FROM NOW()) * 1000`. SQLite skips this migration
 * — its synchronize path leaves the columns NULLable, and tests don't
 * exercise raw INSERT paths on the sqlite branch.
 */
export class RestoreTimestampDefaults1781500000000 implements MigrationInterface {
    name = 'RestoreTimestampDefaults1781500000000';

    private static readonly TRACKED_TABLES = [
        'address_settings_entity',
        'best_difficulty_tracker_entity',
        'blocks_entity',
        'client_entity',
        'client_difficulty_statistics_entity',
        'client_rejected_statistics_entity',
        'client_statistics_entity',
        'external_shares_entity',
        'network_difficulty_tracker_entity',
        'ntfy_subscriptions_entity',
        'pool_rejected_statistics_entity',
        'pool_share_statistics_entity',
        'push_subscription_entity',
        'telegram_subscriptions_entity',
    ];

    private static readonly BIGINT_DEFAULT = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { BIGINT_DEFAULT, TRACKED_TABLES } = RestoreTimestampDefaults1781500000000;

        for (const t of TRACKED_TABLES) {
            await queryRunner.query(
                `ALTER TABLE ${t} ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
            );
            await queryRunner.query(
                `ALTER TABLE ${t} ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
            );
        }

        // Tables outside the TrackedEntity family that also have bigint
        // timestamp columns from the 1781000-1781300 migrations.
        await queryRunner.query(
            `ALTER TABLE pplns_balance ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_payout_history ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_address_email ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_address_email ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_email_verification ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group_balance ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group_block_history ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group_invitation ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group_join_request ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
        await queryRunner.query(
            `ALTER TABLE pplns_group_member ALTER COLUMN "joinedAt" SET DEFAULT ${BIGINT_DEFAULT}`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TRACKED_TABLES } = RestoreTimestampDefaults1781500000000;

        for (const t of TRACKED_TABLES) {
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "createdAt" DROP DEFAULT`);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "updatedAt" DROP DEFAULT`);
        }
        for (const t of [
            'pplns_balance', 'pplns_payout_history', 'pplns_address_email',
            'pplns_email_verification', 'pplns_group', 'pplns_group_balance',
            'pplns_group_block_history', 'pplns_group_invitation',
            'pplns_group_join_request', 'pplns_group_member',
        ]) {
            const cols = ['createdAt', 'updatedAt', 'joinedAt'];
            for (const c of cols) {
                await queryRunner.query(
                    `ALTER TABLE ${t} ALTER COLUMN "${c}" DROP DEFAULT`,
                ).catch(() => undefined);
            }
        }
    }
}
