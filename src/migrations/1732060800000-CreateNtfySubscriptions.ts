import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNtfySubscriptions1732060800000 implements MigrationInterface {
    name = 'CreateNtfySubscriptions1732060800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Create the new ntfy_subscriptions_entity table
        await queryRunner.query(`
            CREATE TABLE "ntfy_subscriptions_entity" (
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "id" SERIAL NOT NULL,
                "address" character varying(62) NOT NULL,
                "language" character varying NOT NULL DEFAULT 'de',
                "bestDiffNotificationsEnabled" boolean NOT NULL DEFAULT true,
                "deviceNotificationsEnabled" boolean NOT NULL DEFAULT false,
                "hourlyStatsEnabled" boolean NOT NULL DEFAULT false,
                "hourlyWorkersEnabled" boolean NOT NULL DEFAULT false,
                CONSTRAINT "UQ_ntfy_subscriptions_address" UNIQUE ("address"),
                CONSTRAINT "PK_ntfy_subscriptions_entity" PRIMARY KEY ("id")
            )
        `);

        // 2. Create index on address
        await queryRunner.query(`
            CREATE INDEX "IDX_ntfy_subscriptions_address" ON "ntfy_subscriptions_entity" ("address")
        `);

        // 3. Migrate NTFY-only data (where telegramChatId IS NULL) if any exist
        // Note: hourlyStatsEnabled and hourlyWorkersEnabled don't exist in telegram_subscriptions_entity
        // so we use default values (false) for the new ntfy_subscriptions_entity table
        await queryRunner.query(`
            INSERT INTO "ntfy_subscriptions_entity"
                ("address", "language", "bestDiffNotificationsEnabled", "deviceNotificationsEnabled", "hourlyStatsEnabled", "hourlyWorkersEnabled", "createdAt", "updatedAt")
            SELECT
                "address",
                'de' as "language",
                COALESCE("bestDiffNotificationsEnabled", true) as "bestDiffNotificationsEnabled",
                COALESCE("deviceNotificationsEnabled", false) as "deviceNotificationsEnabled",
                false as "hourlyStatsEnabled",
                false as "hourlyWorkersEnabled",
                COALESCE("createdAt", now()) as "createdAt",
                COALESCE("updatedAt", now()) as "updatedAt"
            FROM "telegram_subscriptions_entity"
            WHERE "telegramChatId" IS NULL
            ON CONFLICT ("address") DO NOTHING
        `);

        // 4. Delete migrated entries from telegram_subscriptions_entity
        await queryRunner.query(`
            DELETE FROM "telegram_subscriptions_entity"
            WHERE "telegramChatId" IS NULL
        `);

        // 5. Make telegramChatId NOT NULL (in case it was nullable)
        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ALTER COLUMN "telegramChatId" SET NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Make telegramChatId nullable again
        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ALTER COLUMN "telegramChatId" DROP NOT NULL
        `);

        // 2. Migrate data back from ntfy_subscriptions_entity to telegram_subscriptions_entity
        // Note: telegram_subscriptions_entity doesn't have hourlyStatsEnabled/hourlyWorkersEnabled columns
        // so we only migrate the columns that exist in both tables
        await queryRunner.query(`
            INSERT INTO "telegram_subscriptions_entity"
                ("address", "telegramChatId", "bestDiffNotificationsEnabled", "deviceNotificationsEnabled", "isDefault", "createdAt", "updatedAt")
            SELECT
                "address",
                NULL as "telegramChatId",
                "bestDiffNotificationsEnabled",
                "deviceNotificationsEnabled",
                false as "isDefault",
                "createdAt",
                "updatedAt"
            FROM "ntfy_subscriptions_entity"
            ON CONFLICT DO NOTHING
        `);

        // 3. Drop index
        await queryRunner.query(`
            DROP INDEX "IDX_ntfy_subscriptions_address"
        `);

        // 4. Drop the ntfy_subscriptions_entity table
        await queryRunner.query(`
            DROP TABLE "ntfy_subscriptions_entity"
        `);
    }
}
