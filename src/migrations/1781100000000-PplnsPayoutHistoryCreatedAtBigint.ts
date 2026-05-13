import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `pplns_payout_history.createdAt` from timestamptz → bigint (epoch ms).
 * Per the wider Date → bigint cleanup. Table is append-only (one row
 * per (block × address) payout); rewrite is bounded by the lifetime
 * miner-block count.
 */
export class PplnsPayoutHistoryCreatedAtBigint1781100000000 implements MigrationInterface {
    name = 'PplnsPayoutHistoryCreatedAtBigint1781100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE pplns_payout_history
            ALTER COLUMN "createdAt" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_payout_history
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE pplns_payout_history
            ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE
            USING to_timestamp("createdAt" / 1000.0)
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_payout_history
            ALTER COLUMN "createdAt" SET DEFAULT now()
        `);
    }
}
