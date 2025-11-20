import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientDifficultyStatistics1717430400000 implements MigrationInterface {
    name = 'AddClientDifficultyStatistics1717430400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;

        if (dbType === 'postgres') {
            await queryRunner.query(`
                CREATE TABLE "client_difficulty_statistics_entity" (
                    "deletedAt" TIMESTAMP WITH TIME ZONE,
                    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                    "id" SERIAL NOT NULL,
                    "address" character varying(62) NOT NULL,
                    "clientName" character varying(64),
                    "slotTime" integer NOT NULL,
                    "maxDifficulty" real NOT NULL DEFAULT '0',
                    CONSTRAINT "PK_client_difficulty_statistics_entity_id" PRIMARY KEY ("id")
                )
            `);
            await queryRunner.query(`
                CREATE UNIQUE INDEX "IDX_client_difficulty_statistics_unique"
                ON "client_difficulty_statistics_entity" ("address", "clientName", "slotTime")
            `);
        } else if (dbType === 'sqlite') {
            await queryRunner.query(`
                CREATE TABLE "client_difficulty_statistics_entity" (
                    "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                    "deletedAt" datetime,
                    "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                    "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
                    "address" varchar(62) NOT NULL,
                    "clientName" varchar(64),
                    "slotTime" integer NOT NULL,
                    "maxDifficulty" real NOT NULL DEFAULT (0)
                )
            `);
            await queryRunner.query(`
                CREATE UNIQUE INDEX "IDX_client_difficulty_statistics_unique"
                ON "client_difficulty_statistics_entity" ("address", "clientName", "slotTime")
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;

        if (dbType === 'postgres') {
            await queryRunner.query(`DROP INDEX "public"."IDX_client_difficulty_statistics_unique"`);
            await queryRunner.query(`DROP TABLE "client_difficulty_statistics_entity"`);
        } else if (dbType === 'sqlite') {
            await queryRunner.query(`DROP INDEX "IDX_client_difficulty_statistics_unique"`);
            await queryRunner.query(`DROP TABLE "client_difficulty_statistics_entity"`);
        }
    }
}
