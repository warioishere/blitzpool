import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert all timestamp / timestamptz columns on the email tables to
 * `bigint` (epoch ms). Both tables are small (one verified row per
 * email-bound miner; pending verification tokens TTL 24h).
 */
export class EmailTimestampsToBigint1781200000000 implements MigrationInterface {
    name = 'EmailTimestampsToBigint1781200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const BIGINT_DEFAULT = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;
        // pplns_address_email
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "updatedAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "verifiedAt" TYPE BIGINT
            USING CASE WHEN "verifiedAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "verifiedAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "updatedAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "updatedAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_email_verification
        await queryRunner.query(`ALTER TABLE pplns_email_verification ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_email_verification
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_email_verification
            ALTER COLUMN "expiresAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "expiresAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`ALTER TABLE pplns_email_verification ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE pplns_email_verification ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_email_verification
            ALTER COLUMN "expiresAt" TYPE TIMESTAMP
            USING to_timestamp("expiresAt" / 1000.0) AT TIME ZONE 'UTC'
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_email_verification
            ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE
            USING to_timestamp("createdAt" / 1000.0)
        `);
        await queryRunner.query(`ALTER TABLE pplns_email_verification ALTER COLUMN "createdAt" SET DEFAULT now()`);

        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "updatedAt" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE
            USING to_timestamp("updatedAt" / 1000.0)
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE
            USING to_timestamp("createdAt" / 1000.0)
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_address_email
            ALTER COLUMN "verifiedAt" TYPE TIMESTAMP
            USING CASE WHEN "verifiedAt" IS NULL THEN NULL
                       ELSE to_timestamp("verifiedAt" / 1000.0) AT TIME ZONE 'UTC' END
        `);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "updatedAt" SET DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE pplns_address_email ALTER COLUMN "createdAt" SET DEFAULT now()`);
    }
}
