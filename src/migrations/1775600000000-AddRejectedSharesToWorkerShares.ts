import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRejectedSharesToWorkerShares1775600000000 implements MigrationInterface {
    name = 'AddRejectedSharesToWorkerShares1775600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        await queryRunner.query(`
            ALTER TABLE "worker_shares_entity"
            ADD COLUMN "rejectedShares" double precision NOT NULL DEFAULT 0
        `);

        // Seed historical rejected totals from client_statistics_entity.
        // The three Diff1 columns store difficulty-weighted counts (matching what
        // getTotalRejectedForWorkers used to SUM), so summing them gives the same
        // all-time total that was previously computed on every API call.
        await queryRunner.query(`
            UPDATE "worker_shares_entity"
            SET "rejectedShares" = cs.total_rejected
            FROM (
                SELECT address, "clientName",
                    SUM(
                        COALESCE("rejectedJobNotFoundDiff1", 0) +
                        COALESCE("rejectedDuplicateShareDiff1", 0) +
                        COALESCE("rejectedLowDifficultyShareDiff1", 0)
                    ) AS total_rejected
                FROM client_statistics_entity
                GROUP BY address, "clientName"
            ) cs
            WHERE "worker_shares_entity".address = cs.address
              AND "worker_shares_entity"."clientName" = cs."clientName"
              AND cs.total_rejected > 0
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        await queryRunner.query(`
            ALTER TABLE "worker_shares_entity"
            DROP COLUMN "rejectedShares"
        `);
    }
}
