import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientDifficultyStatistics1717430400000 implements MigrationInterface {
    name = 'AddClientDifficultyStatistics1717430400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            CREATE TABLE "client_difficulty_statistics_entity" (
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "id" SERIAL NOT NULL,
                "address" character varying(62) NOT NULL,
                "clientName" character varying(64),
                "slotTime" bigint NOT NULL,
                "maxDifficulty" real NOT NULL DEFAULT '0',
                CONSTRAINT "PK_client_difficulty_statistics_entity_id" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_client_difficulty_statistics_unique"
            ON "client_difficulty_statistics_entity" ("address", "clientName", "slotTime")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        await queryRunner.query(`DROP INDEX "public"."IDX_client_difficulty_statistics_unique"`);
        await queryRunner.query(`DROP TABLE "client_difficulty_statistics_entity"`);
    }
}
