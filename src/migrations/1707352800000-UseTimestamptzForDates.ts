import { MigrationInterface, QueryRunner } from 'typeorm';

const TRACKED_TABLES = [
    'address_settings_entity',
    'blocks_entity',
    'client_entity',
    'client_rejected_statistics_entity',
    'client_statistics_entity',
    'external_shares_entity',
    'pool_rejected_statistics_entity',
    'pool_share_statistics_entity',
    'telegram_subscriptions_entity',
];

export class UseTimestamptzForDates1707352800000 implements MigrationInterface {
    name = 'UseTimestamptzForDates1707352800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        const database = (queryRunner.connection.options as { database?: string }).database;
        const isPgMem = database === 'pg-mem';

        for (const table of TRACKED_TABLES) {
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" DROP DEFAULT`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" DROP DEFAULT`);

            if (isPgMem) {
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE`);
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE`);
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "deletedAt" TYPE TIMESTAMP WITH TIME ZONE`);
            } else {
                await queryRunner.query(`
                    ALTER TABLE "${table}"
                    ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE USING "createdAt" AT TIME ZONE 'UTC'
                `);
                await queryRunner.query(`
                    ALTER TABLE "${table}"
                    ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE USING "updatedAt" AT TIME ZONE 'UTC'
                `);
                await queryRunner.query(`
                    ALTER TABLE "${table}" ALTER COLUMN "deletedAt" TYPE TIMESTAMP WITH TIME ZONE USING CASE
                        WHEN "deletedAt" IS NULL THEN NULL
                        ELSE "deletedAt" AT TIME ZONE 'UTC'
                    END
                `);
            }
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "deletedAt" DROP NOT NULL`);

            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" SET DEFAULT now()`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" SET DEFAULT now()`);
        }

        if (isPgMem) {
            await queryRunner.query(`ALTER TABLE "client_entity" ALTER COLUMN "startTime" TYPE TIMESTAMP WITH TIME ZONE`);
            await queryRunner.query(`ALTER TABLE "client_entity" ALTER COLUMN "firstSeen" TYPE TIMESTAMP WITH TIME ZONE`);
        } else {
            await queryRunner.query(`
                ALTER TABLE "client_entity"
                ALTER COLUMN "startTime" TYPE TIMESTAMP WITH TIME ZONE USING "startTime" AT TIME ZONE 'UTC'
            `);
            await queryRunner.query(`
                ALTER TABLE "client_entity" ALTER COLUMN "firstSeen" TYPE TIMESTAMP WITH TIME ZONE USING CASE
                    WHEN "firstSeen" IS NULL THEN NULL
                    ELSE "firstSeen" AT TIME ZONE 'UTC'
                END
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        const database = (queryRunner.connection.options as { database?: string }).database;
        const isPgMem = database === 'pg-mem';

        if (isPgMem) {
            await queryRunner.query(`ALTER TABLE "client_entity" ALTER COLUMN "startTime" TYPE TIMESTAMP WITHOUT TIME ZONE`);
            await queryRunner.query(`ALTER TABLE "client_entity" ALTER COLUMN "firstSeen" TYPE TIMESTAMP WITHOUT TIME ZONE`);
        } else {
            await queryRunner.query(`
                ALTER TABLE "client_entity"
                ALTER COLUMN "startTime" TYPE TIMESTAMP WITHOUT TIME ZONE USING "startTime"::timestamp
            `);
            await queryRunner.query(`
                ALTER TABLE "client_entity" ALTER COLUMN "firstSeen" TYPE TIMESTAMP WITHOUT TIME ZONE USING CASE
                    WHEN "firstSeen" IS NULL THEN NULL
                    ELSE "firstSeen"::timestamp
                END
            `);
        }

        for (const table of TRACKED_TABLES) {
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" DROP DEFAULT`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" DROP DEFAULT`);

            if (isPgMem) {
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" TYPE TIMESTAMP WITHOUT TIME ZONE`);
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITHOUT TIME ZONE`);
                await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "deletedAt" TYPE TIMESTAMP WITHOUT TIME ZONE`);
            } else {
                await queryRunner.query(`
                    ALTER TABLE "${table}"
                    ALTER COLUMN "createdAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING "createdAt"::timestamp
                `);
                await queryRunner.query(`
                    ALTER TABLE "${table}"
                    ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updatedAt"::timestamp
                `);
                await queryRunner.query(`
                    ALTER TABLE "${table}" ALTER COLUMN "deletedAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING CASE
                        WHEN "deletedAt" IS NULL THEN NULL
                        ELSE "deletedAt"::timestamp
                    END
                `);
            }

            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "createdAt" SET DEFAULT now()`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "updatedAt" SET DEFAULT now()`);
        }
    }
}
