import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePushNotifications1734192000000 implements MigrationInterface {
    name = 'CreatePushNotifications1734192000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Create the push_subscription_entity table
        await queryRunner.query(`
            CREATE TABLE "push_subscription_entity" (
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "id" SERIAL NOT NULL,
                "address" character varying(62) NOT NULL,
                "endpoint" text NOT NULL,
                "platform" character varying NOT NULL DEFAULT 'unknown',
                "lastNotificationAt" bigint,
                CONSTRAINT "UQ_push_subscription_address_endpoint" UNIQUE ("address", "endpoint"),
                CONSTRAINT "PK_push_subscription_entity" PRIMARY KEY ("id")
            )
        `);

        // 2. Create index on address
        await queryRunner.query(`
            CREATE INDEX "IDX_push_subscription_address" ON "push_subscription_entity" ("address")
        `);

        // 3. Create the best_difficulty_tracker_entity table
        await queryRunner.query(`
            CREATE TABLE "best_difficulty_tracker_entity" (
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "address" character varying(62) NOT NULL,
                "bestDifficulty" double precision NOT NULL,
                "lastCheckedAt" bigint NOT NULL,
                CONSTRAINT "PK_best_difficulty_tracker_entity" PRIMARY KEY ("address")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Drop best_difficulty_tracker_entity table
        await queryRunner.query(`
            DROP TABLE "best_difficulty_tracker_entity"
        `);

        // 2. Drop index
        await queryRunner.query(`
            DROP INDEX "IDX_push_subscription_address"
        `);

        // 3. Drop push_subscription_entity table
        await queryRunner.query(`
            DROP TABLE "push_subscription_entity"
        `);
    }
}
