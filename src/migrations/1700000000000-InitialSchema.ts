import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
    name = 'InitialSchema1700000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "address_settings_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "address" character varying(62) NOT NULL, "shares" integer NOT NULL DEFAULT '0', "bestDifficulty" real NOT NULL DEFAULT '0', "miscCoinbaseScriptData" character varying, "bestDifficultyUserAgent" character varying, CONSTRAINT "PK_d20f2ff951af47908573162bafe" PRIMARY KEY ("address"))`);
        await queryRunner.query(`CREATE TABLE "blocks_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "height" integer NOT NULL, "minerAddress" character varying(62) NOT NULL, "worker" character varying NOT NULL, "sessionId" character varying(8) NOT NULL, "blockData" character varying NOT NULL, CONSTRAINT "PK_6b5cb3b7439f2c66cdb0156f703" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "client_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "address" character varying(62) NOT NULL, "clientName" character varying(64) NOT NULL, "sessionId" character varying(8) NOT NULL, "userAgent" character varying(128), "startTime" TIMESTAMP NOT NULL, "firstSeen" TIMESTAMP, "bestDifficulty" real NOT NULL DEFAULT '0', "hashRate" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_72591a7d9edf0ec824243c68aeb" PRIMARY KEY ("address", "clientName", "sessionId"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_72591a7d9edf0ec824243c68ae" ON "client_entity" ("address", "clientName", "sessionId") `);
        await queryRunner.query(`CREATE TABLE "client_rejected_statistics_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "address" character varying(62) NOT NULL, "time" integer NOT NULL, "reason" character varying NOT NULL, "count" real NOT NULL DEFAULT '0', "shares" real NOT NULL DEFAULT '0', CONSTRAINT "UQ_8b864b9a747bbf963241e46a99a" UNIQUE ("address", "time", "reason"), CONSTRAINT "PK_33d6282ff85d90fb12e3e5b0948" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "client_statistics_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "address" character varying(62) NOT NULL, "clientName" character varying NOT NULL, "sessionId" character varying(8) NOT NULL, "time" integer NOT NULL, "shares" real NOT NULL, "acceptedCount" integer NOT NULL DEFAULT '0', "rejectedCount" integer NOT NULL DEFAULT '0', "rejectedJobNotFoundCount" integer NOT NULL DEFAULT '0', "rejectedJobNotFoundDiff1" real NOT NULL DEFAULT '0', "rejectedDuplicateShareCount" integer NOT NULL DEFAULT '0', "rejectedDuplicateShareDiff1" real NOT NULL DEFAULT '0', "rejectedLowDifficultyShareCount" integer NOT NULL DEFAULT '0', "rejectedLowDifficultyShareDiff1" real NOT NULL DEFAULT '0', CONSTRAINT "PK_b62c23f526570c9284b894e9c11" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7d081302c6f984f26f81caa5cc" ON "client_statistics_entity" ("time") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b38d02abcd76df0c3b6695a21" ON "client_statistics_entity" ("address", "clientName", "sessionId", "time") `);
        await queryRunner.query(`CREATE INDEX "IDX_acc4a8ade593446d2bbe801e38" ON "client_statistics_entity" ("address", "clientName", "sessionId") `);
        await queryRunner.query(`CREATE TABLE "external_shares_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "address" character varying(62) NOT NULL, "clientName" character varying NOT NULL, "time" integer NOT NULL, "difficulty" real NOT NULL, "userAgent" character varying(128), "externalPoolName" character varying(128), "header" character varying NOT NULL, CONSTRAINT "PK_36fdb7a4e3e93e017bc4bfa3047" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e15b2d6740ce54f1e231cb0444" ON "external_shares_entity" ("address", "time") `);
        await queryRunner.query(`CREATE TABLE "pool_rejected_statistics_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "time" integer NOT NULL, "reason" character varying NOT NULL, "count" real NOT NULL DEFAULT '0', CONSTRAINT "UQ_95efa6065f98aac8076bfe2cb05" UNIQUE ("time", "reason"), CONSTRAINT "PK_a775609a3adb8274bc383466563" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "pool_share_statistics_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "time" integer NOT NULL, "accepted" real NOT NULL DEFAULT '0', "rejected" real NOT NULL DEFAULT '0', CONSTRAINT "UQ_1e8bf1f7a6775ce455ae3fd5a08" UNIQUE ("time"), CONSTRAINT "PK_f962c8caee66b1dc18949f19284" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "rpc_block_entity" ("blockHeight" integer NOT NULL, "lockedBy" character varying, "data" character varying, CONSTRAINT "PK_1d879c7524320d41601c8916262" PRIMARY KEY ("blockHeight"))`);
        await queryRunner.query(`CREATE TABLE "telegram_subscriptions_entity" ("deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "address" character varying(62) NOT NULL, "telegramChatId" integer NOT NULL, "bestDiffNotificationsEnabled" boolean NOT NULL DEFAULT true, "isDefault" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_93b0925f78fa753929f313021c7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e03795301e82c3fd4c0d50f114" ON "telegram_subscriptions_entity" ("address") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_e03795301e82c3fd4c0d50f114"`);
        await queryRunner.query(`DROP TABLE "telegram_subscriptions_entity"`);
        await queryRunner.query(`DROP TABLE "rpc_block_entity"`);
        await queryRunner.query(`DROP TABLE "pool_share_statistics_entity"`);
        await queryRunner.query(`DROP TABLE "pool_rejected_statistics_entity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e15b2d6740ce54f1e231cb0444"`);
        await queryRunner.query(`DROP TABLE "external_shares_entity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_acc4a8ade593446d2bbe801e38"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b38d02abcd76df0c3b6695a21"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7d081302c6f984f26f81caa5cc"`);
        await queryRunner.query(`DROP TABLE "client_statistics_entity"`);
        await queryRunner.query(`DROP TABLE "client_rejected_statistics_entity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_72591a7d9edf0ec824243c68ae"`);
        await queryRunner.query(`DROP TABLE "client_entity"`);
        await queryRunner.query(`DROP TABLE "blocks_entity"`);
        await queryRunner.query(`DROP TABLE "address_settings_entity"`);
    }

}
