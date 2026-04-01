import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHourlyStatsToTelegramSubscriptions1770000000000 implements MigrationInterface {
    name = 'AddHourlyStatsToTelegramSubscriptions1770000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ADD COLUMN "hourlyStatsEnabled" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ADD COLUMN "hourlyWorkersEnabled" boolean NOT NULL DEFAULT false
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`ALTER TABLE "telegram_subscriptions_entity" DROP COLUMN "hourlyWorkersEnabled"`);
        await queryRunner.query(`ALTER TABLE "telegram_subscriptions_entity" DROP COLUMN "hourlyStatsEnabled"`);
    }
}
