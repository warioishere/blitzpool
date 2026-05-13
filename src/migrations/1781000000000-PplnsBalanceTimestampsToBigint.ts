import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert `pplns_balance` Date columns from `timestamptz` → `bigint`
 * (epoch milliseconds). Drops TypeORM's Date hydration + pg-types
 * `parseDate` (3.57% self CPU on 2026-05-13 prod profile) from the hot
 * path. The dust-sweep cron + abandoned-balance reads compare epoch
 * numbers directly instead of `Date.getTime() > cutoff`.
 *
 * Blocking conversion: `ALTER COLUMN TYPE BIGINT USING (EXTRACT
 * (EPOCH FROM ...) * 1000)::BIGINT`. pplns_balance is small (one row
 * per active PPLNS miner with non-zero balance ≈ a few hundred rows
 * at most), so the table-rewrite completes in << 1 s.
 */
export class PplnsBalanceTimestampsToBigint1781000000000 implements MigrationInterface {
    name = 'PplnsBalanceTimestampsToBigint1781000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "lastAcceptedShareAt" TYPE BIGINT
            USING CASE
                WHEN "lastAcceptedShareAt" IS NULL THEN NULL
                ELSE (EXTRACT(EPOCH FROM "lastAcceptedShareAt") * 1000)::BIGINT
            END
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "updatedAt" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "updatedAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "updatedAt") * 1000)::BIGINT
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "lastAcceptedShareAt" TYPE TIMESTAMP WITH TIME ZONE
            USING CASE
                WHEN "lastAcceptedShareAt" IS NULL THEN NULL
                ELSE to_timestamp("lastAcceptedShareAt" / 1000.0)
            END
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE
            USING to_timestamp("updatedAt" / 1000.0)
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_balance
            ALTER COLUMN "updatedAt" SET DEFAULT now()
        `);
    }
}
