import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert all Date columns on the 6 pplns_group_* tables to `bigint`
 * (epoch ms). Single migration because they all share the same
 * conversion shape and are typically updated together. All tables are
 * small (per-group cardinality), table-rewrite is negligible.
 */
export class PplnsGroupTimestampsToBigint1781300000000 implements MigrationInterface {
    name = 'PplnsGroupTimestampsToBigint1781300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const BIGINT_DEFAULT = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

        // pplns_group
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "updatedAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group
            ALTER COLUMN "updatedAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "updatedAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group
            ALTER COLUMN "dissolvedAt" TYPE BIGINT
            USING CASE WHEN "dissolvedAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "dissolvedAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group
            ALTER COLUMN "lastRoundResetAt" TYPE BIGINT
            USING CASE WHEN "lastRoundResetAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "lastRoundResetAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_group_balance
        await queryRunner.query(`ALTER TABLE pplns_group_balance ALTER COLUMN "updatedAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group_balance
            ALTER COLUMN "updatedAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "updatedAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group_balance
            ALTER COLUMN "lastAcceptedShareAt" TYPE BIGINT
            USING CASE WHEN "lastAcceptedShareAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "lastAcceptedShareAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`ALTER TABLE pplns_group_balance ALTER COLUMN "updatedAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_group_block_history
        await queryRunner.query(`ALTER TABLE pplns_group_block_history ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group_block_history
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`ALTER TABLE pplns_group_block_history ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_group_invitation
        await queryRunner.query(`ALTER TABLE pplns_group_invitation ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group_invitation
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group_invitation
            ALTER COLUMN "expiresAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "expiresAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group_invitation
            ALTER COLUMN "respondedAt" TYPE BIGINT
            USING CASE WHEN "respondedAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "respondedAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`ALTER TABLE pplns_group_invitation ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_group_join_request
        await queryRunner.query(`ALTER TABLE pplns_group_join_request ALTER COLUMN "createdAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group_join_request
            ALTER COLUMN "createdAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "createdAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`
            ALTER TABLE pplns_group_join_request
            ALTER COLUMN "decidedAt" TYPE BIGINT
            USING CASE WHEN "decidedAt" IS NULL THEN NULL
                       ELSE (EXTRACT(EPOCH FROM "decidedAt") * 1000)::BIGINT END
        `);
        await queryRunner.query(`ALTER TABLE pplns_group_join_request ALTER COLUMN "createdAt" SET DEFAULT ${BIGINT_DEFAULT}`);

        // pplns_group_member
        await queryRunner.query(`ALTER TABLE pplns_group_member ALTER COLUMN "joinedAt" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE pplns_group_member
            ALTER COLUMN "joinedAt" TYPE BIGINT
            USING (EXTRACT(EPOCH FROM "joinedAt") * 1000)::BIGINT
        `);
        await queryRunner.query(`ALTER TABLE pplns_group_member ALTER COLUMN "joinedAt" SET DEFAULT ${BIGINT_DEFAULT}`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse — convert bigint epoch-ms back to timestamps and restore defaults.
        const restoreTimestamp = async (table: string, col: string, nullable: boolean) => {
            await queryRunner.query(`ALTER TABLE ${table} ALTER COLUMN "${col}" DROP DEFAULT`).catch(() => undefined);
            if (nullable) {
                await queryRunner.query(`
                    ALTER TABLE ${table}
                    ALTER COLUMN "${col}" TYPE TIMESTAMP WITH TIME ZONE
                    USING CASE WHEN "${col}" IS NULL THEN NULL
                               ELSE to_timestamp("${col}" / 1000.0) END
                `);
            } else {
                await queryRunner.query(`
                    ALTER TABLE ${table}
                    ALTER COLUMN "${col}" TYPE TIMESTAMP WITH TIME ZONE
                    USING to_timestamp("${col}" / 1000.0)
                `);
            }
        };

        await restoreTimestamp('pplns_group_member', 'joinedAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group_member ALTER COLUMN "joinedAt" SET DEFAULT now()`);

        await restoreTimestamp('pplns_group_join_request', 'decidedAt', true);
        await restoreTimestamp('pplns_group_join_request', 'createdAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group_join_request ALTER COLUMN "createdAt" SET DEFAULT now()`);

        await restoreTimestamp('pplns_group_invitation', 'respondedAt', true);
        await restoreTimestamp('pplns_group_invitation', 'expiresAt', false);
        await restoreTimestamp('pplns_group_invitation', 'createdAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group_invitation ALTER COLUMN "createdAt" SET DEFAULT now()`);

        await restoreTimestamp('pplns_group_block_history', 'createdAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group_block_history ALTER COLUMN "createdAt" SET DEFAULT now()`);

        await restoreTimestamp('pplns_group_balance', 'lastAcceptedShareAt', true);
        await restoreTimestamp('pplns_group_balance', 'updatedAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group_balance ALTER COLUMN "updatedAt" SET DEFAULT now()`);

        await restoreTimestamp('pplns_group', 'lastRoundResetAt', true);
        await restoreTimestamp('pplns_group', 'dissolvedAt', true);
        await restoreTimestamp('pplns_group', 'updatedAt', false);
        await restoreTimestamp('pplns_group', 'createdAt', false);
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "updatedAt" SET DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE pplns_group ALTER COLUMN "createdAt" SET DEFAULT now()`);
    }
}
