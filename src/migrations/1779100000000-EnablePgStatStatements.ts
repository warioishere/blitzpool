import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activates the `pg_stat_statements` extension. The shared library is
 * already preloaded via `shared_preload_libraries=pg_stat_statements`
 * in docker-compose-mainnet-pg.yml, but until `CREATE EXTENSION` runs
 * the statistics views (pg_stat_statements, pg_stat_statements_info)
 * do not exist — making per-query latency profiling impossible.
 *
 * The extension only adds views/functions; no application data is
 * modified. Idempotent via IF NOT EXISTS. Skipped on SQLite.
 */
export class EnablePgStatStatements1779100000000 implements MigrationInterface {
    name = 'EnablePgStatStatements1779100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        // Down keeps the extension in place. Dropping it would discard the
        // accumulated query-statistics history, which is operator-visible
        // diagnostic state — a rollback of the migration shouldn't erase
        // observability data the operator may currently be reading.
    }
}
