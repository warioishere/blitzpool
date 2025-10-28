import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceNotificationsToTelegramSubscriptions1718000000000 implements MigrationInterface {
    name = 'AddDeviceNotificationsToTelegramSubscriptions1718000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ADD "deviceNotificationsEnabled" boolean NOT NULL DEFAULT false
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            DROP COLUMN "deviceNotificationsEnabled"
        `);
    }
}
