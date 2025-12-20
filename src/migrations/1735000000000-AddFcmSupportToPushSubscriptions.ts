import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFcmSupportToPushSubscriptions1735000000000
    implements MigrationInterface
{
    name = 'AddFcmSupportToPushSubscriptions1735000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Add subscriptionType column with default 'unified_push'
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ADD COLUMN "subscriptionType" character varying(20) NOT NULL DEFAULT 'unified_push'`
        );

        // 2. Create index on subscriptionType for efficient queries
        await queryRunner.query(
            `CREATE INDEX "IDX_push_subscription_type"
             ON "push_subscription_entity" ("subscriptionType")`
        );

        // 3. Drop old unique constraint (address, endpoint)
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             DROP CONSTRAINT "UQ_push_subscription_address_endpoint"`
        );

        // 4. Add new unique constraint (address, endpoint, subscriptionType)
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ADD CONSTRAINT "UQ_push_subscription_address_endpoint_type"
             UNIQUE ("address", "endpoint", "subscriptionType")`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // 1. Drop new unique constraint
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             DROP CONSTRAINT "UQ_push_subscription_address_endpoint_type"`
        );

        // 2. Restore old unique constraint
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             ADD CONSTRAINT "UQ_push_subscription_address_endpoint"
             UNIQUE ("address", "endpoint")`
        );

        // 3. Drop subscriptionType index
        await queryRunner.query(
            `DROP INDEX "IDX_push_subscription_type"`
        );

        // 4. Drop subscriptionType column
        await queryRunner.query(
            `ALTER TABLE "push_subscription_entity"
             DROP COLUMN "subscriptionType"`
        );
    }
}
