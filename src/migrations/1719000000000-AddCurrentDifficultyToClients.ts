import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCurrentDifficultyToClients1719000000000 implements MigrationInterface {
    name = 'AddCurrentDifficultyToClients1719000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_entity" ADD "currentDifficulty" real`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_entity" DROP COLUMN "currentDifficulty"`);
    }
}
