import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add performance indexes optimized for PostgreSQL mining pool workload.
 *
 * These indexes cover the most frequent query patterns that are NOT already
 * served by existing indexes or unique constraints.
 *
 * Existing coverage (no action needed):
 *   client_statistics_entity:
 *     - (address, clientName, sessionId)           — getHashRateForSession
 *     - (address, clientName, sessionId, time)     — upsert composite key
 *     - UNIQUE(address, clientName, sessionId, time)
 *     - (time)                                     — standalone
 *   client_entity:
 *     - UNIQUE(address, clientName, sessionId)     — PK composite
 *   pool_share_statistics_entity:
 *     - UNIQUE(time)                               — upsert key
 *   client_difficulty_statistics_entity:
 *     - UNIQUE(address, clientName, slotTime)      — upsert key
 *   client_rejected_statistics_entity:
 *     - UNIQUE(address, time, reason)              — upsert key
 *   pool_rejected_statistics_entity:
 *     - UNIQUE(time, reason)                       — upsert key
 *   push_subscription_entity:
 *     - (address)                                  — standalone
 *     - (subscriptionType)                         — standalone
 *     - UNIQUE(address, endpoint, subscriptionType)
 *   external_shares_entity:
 *     - (address, time)                            — composite
 *   telegram_subscriptions_entity:
 *     - (address)                                  — standalone
 *   ntfy_subscriptions_entity:
 *     - UNIQUE(address)                            — standalone
 */
export class AddPerformanceIndexes1769900000000 implements MigrationInterface {
    name = 'AddPerformanceIndexes1769900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        // =====================================================================
        // DROP REDUNDANT INDEXES  (saves write throughput on every INSERT/UPDATE)
        // =====================================================================

        // client_entity: PK (address, clientName, sessionId) already creates a unique B-tree.
        // The separate UNIQUE INDEX from InitialSchema is redundant.
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_72591a7d9edf0ec824243c68ae"`);

        // client_statistics_entity: UNIQUE(address, clientName, sessionId, time) from migration
        // 1767370800000 creates a B-tree that fully covers both of these older indexes.
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5b38d02abcd76df0c3b6695a21"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_acc4a8ade593446d2bbe801e38"`);

        // =====================================================================
        // client_statistics_entity  (highest throughput table)
        // =====================================================================

        // Dashboard: getChartDataForAddress, getAcceptedEntriesSince, getTotalSharesForAddress
        // Query: WHERE address = $1 AND time >= $2 ORDER BY time ASC
        // Existing (address, clientName, sessionId) index doesn't cover address+time range scans
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cs_address_time"
            ON client_statistics_entity (address, time)
        `);

        // Maintenance: deleteOldStatistics aggregates by address + clientName
        // Query: WHERE time < $1 GROUP BY address, clientName
        // Also serves: getChartDataForGroup, getHashRateForGroup
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cs_address_clientname_time"
            ON client_statistics_entity (address, "clientName", time)
        `);

        // =====================================================================
        // client_entity  (hot path: heartbeat, getByAddress, getActiveWorkers)
        // =====================================================================

        // killDeadClients: WHERE deletedAt IS NULL AND updatedAt < $1
        // getActiveWorkerCounts: WHERE deletedAt IS NULL
        // Partial index — only covers active (non-deleted) clients
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_client_active"
            ON client_entity (address, "clientName")
            WHERE "deletedAt" IS NULL
        `);

        // deleteOldClients: WHERE deletedAt < $1
        // Needs to find soft-deleted rows efficiently
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_client_deleted"
            ON client_entity ("deletedAt")
            WHERE "deletedAt" IS NOT NULL
        `);

        // =====================================================================
        // address_settings_entity  (hot: getSettings, addSharesBulk)
        // =====================================================================

        // getHighScores: ORDER BY bestDifficulty DESC LIMIT 10
        // Without this index → full table scan + sort
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_as_bestdifficulty_desc"
            ON address_settings_entity ("bestDifficulty" DESC)
        `);

        // =====================================================================
        // push_subscription_entity  (notification queries by address + type)
        // =====================================================================

        // All notification queries: WHERE address = $1 AND subscriptionType = $2
        // The existing (address) and (subscriptionType) indexes are separate and
        // PG would need a bitmap AND to combine them. A composite index is faster.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ps_address_subtype"
            ON push_subscription_entity (address, "subscriptionType")
        `);

        // Network diff notifications (no address filter): WHERE subscriptionType = $1 AND networkDiffNotificationsEnabled = true
        // These scan the whole table for a specific type — partial index is perfect
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ps_network_diff_notifications"
            ON push_subscription_entity ("subscriptionType")
            WHERE "networkDiffNotificationsEnabled" = true
        `);

        // =====================================================================
        // telegram_subscriptions_entity
        // =====================================================================

        // findByChatId: WHERE telegramChatId = $1  (primary access pattern)
        // saveSubscription: WHERE telegramChatId = $1 AND address = $2
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ts_chatid"
            ON telegram_subscriptions_entity ("telegramChatId")
        `);

        // client_rejected_statistics_entity:
        // UNIQUE(address, time, reason) already covers (address, time) prefix scans.
        // No additional index needed.

        // =====================================================================
        // client_difficulty_statistics_entity
        // =====================================================================

        // getMaximaForAddress: WHERE address = $1 AND slotTime BETWEEN $2 AND $3
        // The UNIQUE(address, clientName, slotTime) has clientName in between
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cds_address_slottime"
            ON client_difficulty_statistics_entity (address, "slotTime")
        `);

        console.log('[Migration] Created performance indexes for PostgreSQL');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        // Drop new performance indexes
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cs_address_time"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cs_address_clientname_time"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_active"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_deleted"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_as_bestdifficulty_desc"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ps_address_subtype"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ps_network_diff_notifications"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ts_chatid"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cds_address_slottime"`);

        // Restore redundant indexes that were dropped in up()
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_72591a7d9edf0ec824243c68ae" ON "client_entity" ("address", "clientName", "sessionId")`);
        await queryRunner.query(`CREATE INDEX "IDX_5b38d02abcd76df0c3b6695a21" ON "client_statistics_entity" ("address", "clientName", "sessionId", "time")`);
        await queryRunner.query(`CREATE INDEX "IDX_acc4a8ade593446d2bbe801e38" ON "client_statistics_entity" ("address", "clientName", "sessionId")`);

        console.log('[Migration] Reverted performance indexes');
    }
}
