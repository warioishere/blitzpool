import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWorkerShares1775200000000 implements MigrationInterface {
    name = 'CreateWorkerShares1775200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            CREATE TABLE "worker_shares_entity" (
                "address" character varying(62) NOT NULL,
                "clientName" character varying NOT NULL,
                "shares" double precision NOT NULL DEFAULT 0,
                CONSTRAINT "PK_worker_shares_entity" PRIMARY KEY ("address", "clientName")
            )
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_worker_shares_address" ON "worker_shares_entity" ("address")
        `);

        // Seed from existing client_statistics data
        await queryRunner.query(`
            INSERT INTO "worker_shares_entity" ("address", "clientName", "shares")
            SELECT address, "clientName", SUM(shares) as shares
            FROM client_statistics_entity
            GROUP BY address, "clientName"
            HAVING SUM(shares) > 0
            ON CONFLICT ("address", "clientName") DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`DROP INDEX "IDX_worker_shares_address"`);
        await queryRunner.query(`DROP TABLE "worker_shares_entity"`);
    }
}
