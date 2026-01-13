import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixPushNotificationDefaults1736780400000
    implements MigrationInterface
{
    name = 'FixPushNotificationDefaults1736780400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Update existing rows to enable all notifications by default
        //    This fixes subscriptions created before the application code was updated
        await queryRunner.query(
            `UPDATE "push_subscription_entity"
             SET
                 "bestDiffNotificationsEnabled" = true,
                 "deviceNotificationsEnabled" = true,
                 "blockNotificationsEnabled" = true
             WHERE
                 "bestDiffNotificationsEnabled" = false
                 OR "deviceNotificationsEnabled" = false
                 OR "blockNotificationsEnabled" = false`
        );

        // 2. Fix database column defaults to match TypeORM entity defaults
        //    This ensures new rows created directly in the database get correct defaults
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "bestDiffNotificationsEnabled" SET DEFAULT true`
        );

        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "deviceNotificationsEnabled" SET DEFAULT true`
        );

        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "blockNotificationsEnabled" SET DEFAULT true`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // Revert database defaults to original (incorrect) values
        // Note: We do NOT revert the data updates, as users likely expect notifications
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "bestDiffNotificationsEnabled" SET DEFAULT false`
        );

        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "deviceNotificationsEnabled" SET DEFAULT false`
        );

        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ALTER COLUMN "blockNotificationsEnabled" SET DEFAULT false`
        );
    }
}
