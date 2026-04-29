import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `IDX_client_heartbeat` from `client_entity`.
 *
 * This index sat on `updatedAt WHERE deletedAt IS NULL`. Every flushed
 * heartbeat (every 30 s, ~thousands per minute) updates `updatedAt`,
 * which lands in this index — and so kills PostgreSQL's HOT-update
 * path. Observed before drop: hot_upd = 4 against n_tup_upd = 14.6 M.
 *
 * The only consumer is `killDeadClients()` (cron, every 2 minutes):
 *   `WHERE deletedAt IS NULL AND updatedAt < cutoff`
 * On the live table this scans ~8k rows; with the partial filter it's
 * a sub-millisecond seq-scan and was responsible for ~30 idx_scans
 * per day — far short of justifying the maintenance cost.
 *
 * Other client_entity indexes are NOT HOT-killers for the heartbeat
 * write set:
 *   - IDX_client_active   (address, "clientName") — these don't change
 *   - IDX_client_session  (sessionId)             — doesn't change
 *   - IDX_client_deleted  (deletedAt) WHERE deletedAt IS NOT NULL
 *                         — partial; alive rows aren't in the index
 *
 * Skipped on SQLite (the index isn't created there either).
 */
export class DropClientHeartbeatIndex1779200000000 implements MigrationInterface {
    name = 'DropClientHeartbeatIndex1779200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_heartbeat"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_client_heartbeat"
            ON client_entity ("updatedAt") WHERE "deletedAt" IS NULL
        `);
    }
}
