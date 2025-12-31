import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNetworkDifficultyNotifications1735200000000
    implements MigrationInterface
{
    name = 'AddNetworkDifficultyNotifications1735200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Add networkDiffNotificationsEnabled column to push_subscription_entity
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ADD COLUMN "networkDiffNotificationsEnabled" boolean NOT NULL DEFAULT true`
        );

        // 2. Create the network_difficulty_tracker_entity table (singleton)
        await queryRunner.query(`
            CREATE TABLE "network_difficulty_tracker_entity" (
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "id" integer NOT NULL DEFAULT 1,
                "currentDifficulty" double precision NOT NULL,
                "previousDifficulty" double precision,
                "lastCheckedAt" bigint NOT NULL,
                "lastChangedAt" bigint,
                CONSTRAINT "PK_network_difficulty_tracker_entity" PRIMARY KEY ("id"),
                CONSTRAINT "CHK_network_difficulty_tracker_singleton" CHECK ("id" = 1)
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Drop network_difficulty_tracker_entity table
        await queryRunner.query(`
            DROP TABLE "network_difficulty_tracker_entity"
        `);

        // 2. Drop networkDiffNotificationsEnabled column
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             DROP COLUMN "networkDiffNotificationsEnabled"`
        );
    }
}
