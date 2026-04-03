import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActiveStatsIndex1775400000000 implements MigrationInterface {
    name = 'AddActiveStatsIndex1775400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        // Partial covering index for getActiveCountsSince() — used by GET /info/workers.
        // Excludes synthetic AGG/POOL rows and covers (time, address, clientName) so PG
        // can do an index-only scan for GROUP BY time + COUNT DISTINCT address/clientName.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cs_real_time_cov"
            ON "client_statistics_entity" (time, address, "clientName")
            WHERE "sessionId" != 'AGG' AND address != 'POOL'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cs_real_time_cov"`);
    }
}
