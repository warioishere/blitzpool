import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Big-bang migration: convert createdAt / updatedAt / deletedAt on every
 * TrackedEntity-extending table from timestamptz to bigint epoch-ms.
 * Plus the two client_entity custom Date columns (startTime, firstSeen).
 *
 * Tables (14):
 *   address_settings_entity
 *   best_difficulty_tracker_entity
 *   blocks_entity
 *   client_entity                        (+ startTime, firstSeen)
 *   client_difficulty_statistics_entity
 *   client_rejected_statistics_entity
 *   client_statistics_entity             ← biggest table (~millions rows)
 *   external_shares_entity
 *   network_difficulty_tracker_entity
 *   ntfy_subscriptions_entity
 *   pool_rejected_statistics_entity
 *   pool_share_statistics_entity
 *   push_subscription_entity
 *   telegram_subscriptions_entity
 *
 * client_statistics_entity is the table-rewrite cost driver — typically
 * ~few minutes on prod-class hardware for ~2.4 M rows. Acceptable for a
 * one-off deploy where the pool restarts; not online-rewrite-safe.
 */
export class TrackedEntityTimestampsToBigint1781400000000 implements MigrationInterface {
    name = 'TrackedEntityTimestampsToBigint1781400000000';

    private static readonly TABLES = [
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

    public async up(queryRunner: QueryRunner): Promise<void> {
        const BIGINT_DEFAULT = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

        for (const t of TrackedEntityTimestampsToBigint1781400000000.TABLES) {
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "createdAt" DROP DEFAULT`);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "updatedAt" DROP DEFAULT`);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "createdAt" TYPE BIGINT
                USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
            `);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "updatedAt" TYPE BIGINT
                USING (EXTRACT(EPOCH FROM "updatedAt") * 1000)::BIGINT
            `);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "deletedAt" TYPE BIGINT
                USING CASE WHEN "deletedAt" IS NULL THEN NULL
                           ELSE (EXTRACT(EPOCH FROM "deletedAt") * 1000)::BIGINT END
            `);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`);
        }

        // client_entity custom Date columns.
        await queryRunner.query(`
            ALTER TABLE client_entity
            ALTER COLUMN "startTime" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "startTime") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE client_entity
            ALTER COLUMN "firstSeen" TYPE BIGINT
            USING CASE WHEN "firstSeen" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "firstSeen") * 1000)::BIGINT END
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE client_entity
            ALTER COLUMN "firstSeen" TYPE TIMESTAMP
            USING CASE WHEN "firstSeen" IS NULL THEN NULL
                       ELSE to_timestamp("firstSeen" / 1000.0) AT TIME ZONE 'UTC' END
        `);
        await queryRunner.query(`
            ALTER TABLE client_entity
            ALTER COLUMN "startTime" TYPE TIMESTAMP
            USING to_timestamp("startTime" / 1000.0) AT TIME ZONE 'UTC'
        `);

        for (const t of [...TrackedEntityTimestampsToBigint1781400000000.TABLES].reverse()) {
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "createdAt" DROP DEFAULT`);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "updatedAt" DROP DEFAULT`);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "deletedAt" TYPE TIMESTAMP
                USING CASE WHEN "deletedAt" IS NULL THEN NULL
                           ELSE to_timestamp("deletedAt" / 1000.0) AT TIME ZONE 'UTC' END
            `);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "updatedAt" TYPE TIMESTAMP
                USING to_timestamp("updatedAt" / 1000.0) AT TIME ZONE 'UTC'
            `);
            await queryRunner.query(`
                ALTER TABLE ${t}
                ALTER COLUMN "createdAt" TYPE TIMESTAMP
                USING to_timestamp("createdAt" / 1000.0) AT TIME ZONE 'UTC'
            `);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "updatedAt" SET DEFAULT now()`);
            await queryRunner.query(`ALTER TABLE ${t} ALTER COLUMN "createdAt" SET DEFAULT now()`);
        }
    }
}
