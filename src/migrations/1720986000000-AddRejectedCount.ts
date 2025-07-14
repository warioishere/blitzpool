import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRejectedCount1720986000000 implements MigrationInterface {
  name = 'AddRejectedCount1720986000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_statistics_entity" ADD COLUMN "rejectedCount" REAL NOT NULL DEFAULT 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_statistics_entity" DROP COLUMN "rejectedCount"`
    );
  }
}

