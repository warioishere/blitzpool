import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientEntityIndexes1775800000000 implements MigrationInterface {
    name = 'AddClientEntityIndexes1775800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const type = queryRunner.connection.options.type;
        if (type !== 'postgres') return;

        // sessionId standalone index — used by softDelete, updateBestDifficulty,
        // updateCurrentDifficulty, updateUserAgent (these only have sessionId)
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_session"
            ON client_entity ("sessionId") WHERE "deletedAt" IS NULL
        `);

        // updatedAt partial index — used by killDeadClients() every 2 minutes
        // (WHERE deletedAt IS NULL AND updatedAt < cutoff)
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_heartbeat"
            ON client_entity ("updatedAt") WHERE "deletedAt" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const type = queryRunner.connection.options.type;
        if (type !== 'postgres') return;

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_session"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_heartbeat"`);
    }
}
