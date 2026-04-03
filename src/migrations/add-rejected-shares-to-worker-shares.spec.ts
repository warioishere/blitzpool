import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { InitialSchema1700000000000 } from './1700000000000-InitialSchema';
import { AddRejectedSharesToWorkerShares1775600000000 } from './1775600000000-AddRejectedSharesToWorkerShares';

/**
 * Minimal migration that creates worker_shares_entity without the HAVING-based seed,
 * which pg-mem does not support.  The real CreateWorkerShares migration is not used
 * here because it seeds from client_statistics_entity using HAVING SUM(shares) > 0.
 */
class CreateWorkerSharesMinimal1775500000000 implements MigrationInterface {
    name = 'CreateWorkerSharesMinimal1775500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "worker_shares_entity" (
                "address" character varying(62) NOT NULL,
                "clientName" character varying NOT NULL,
                "shares" double precision NOT NULL DEFAULT 0,
                CONSTRAINT "PK_worker_shares_entity" PRIMARY KEY ("address", "clientName")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "worker_shares_entity"`);
    }
}

function buildPgMemDataSource(): DataSource {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
        name: 'current_database',
        returns: DataType.text,
        implementation: () => 'pg_mem',
    });
    db.public.registerFunction({
        name: 'version',
        returns: DataType.text,
        implementation: () => 'pg-mem',
    });

    return db.adapters.createTypeormDataSource({
        type: 'postgres',
        database: 'pg-mem',
        entities: [],
        migrations: [
            InitialSchema1700000000000,
            CreateWorkerSharesMinimal1775500000000,
            AddRejectedSharesToWorkerShares1775600000000,
        ],
        synchronize: false,
    });
}

describe('AddRejectedSharesToWorkerShares1775600000000', () => {
    it('skips execution on sqlite', async () => {
        const ds = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            migrations: [AddRejectedSharesToWorkerShares1775600000000],
            synchronize: true,
        });
        await ds.initialize();
        await ds.runMigrations();
        await ds.destroy();
    });

    it('adds the rejectedShares column and is reported as executed', async () => {
        const ds = buildPgMemDataSource();
        await ds.initialize();

        const executed = await ds.runMigrations();

        const names = executed.map(m => m.name);
        expect(names).toContain('AddRejectedSharesToWorkerShares1775600000000');

        // Verify column exists
        const cols = await ds.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'worker_shares_entity'
              AND column_name = 'rejectedShares'
        `);
        expect(cols.length).toBe(1);
        expect(cols[0].data_type).toMatch(/double|float|real/i);

        await ds.destroy();
    });

    it('seeds rejectedShares from client_statistics_entity', async () => {
        // Run only the setup migrations (InitialSchema + CreateWorkerSharesMinimal),
        // insert test data, then run the new migration manually so we can verify the seed.
        const db = newDb({ autoCreateForeignKeyIndices: true });
        db.public.registerFunction({
            name: 'current_database',
            returns: DataType.text,
            implementation: () => 'pg_mem',
        });
        db.public.registerFunction({
            name: 'version',
            returns: DataType.text,
            implementation: () => 'pg-mem',
        });

        const ds = db.adapters.createTypeormDataSource({
            type: 'postgres',
            database: 'pg-mem',
            entities: [],
            migrations: [InitialSchema1700000000000, CreateWorkerSharesMinimal1775500000000],
            synchronize: false,
        });
        await ds.initialize();
        await ds.runMigrations();

        // Insert a worker row and matching client statistics with known rejected values
        await ds.query(`
            INSERT INTO "worker_shares_entity" (address, "clientName", shares)
            VALUES ('addr1', 'rig1', 1000)
        `);
        await ds.query(`
            INSERT INTO "client_statistics_entity"
              (address, "clientName", "sessionId", time, shares,
               "rejectedJobNotFoundDiff1", "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareDiff1",
               "acceptedCount", "rejectedCount", "rejectedJobNotFoundCount",
               "rejectedDuplicateShareCount", "rejectedLowDifficultyShareCount")
            VALUES
              ('addr1', 'rig1', 'sess1', 1700000000000, 500, 3.0, 2.0, 1.0, 10, 3, 1, 1, 1),
              ('addr1', 'rig1', 'sess1', 1700000060000, 500, 0.0, 1.5, 0.5, 10, 1, 0, 1, 0)
        `);

        // Run the new migration manually (bypasses tracking so we control timing)
        const migration = new AddRejectedSharesToWorkerShares1775600000000();
        const qr = ds.createQueryRunner();
        await migration.up(qr);
        await qr.release();

        // Verify: 3+2+1 + 0+1.5+0.5 = 8.0
        const rows = await ds.query(`SELECT "rejectedShares" FROM "worker_shares_entity" WHERE address = 'addr1'`);
        expect(rows.length).toBe(1);
        expect(parseFloat(rows[0].rejectedShares)).toBeCloseTo(8.0);

        await ds.destroy();
    });

    it('down migration removes the rejectedShares column', async () => {
        const ds = buildPgMemDataSource();
        await ds.initialize();
        await ds.runMigrations();

        const qr = ds.createQueryRunner();
        const migration = new AddRejectedSharesToWorkerShares1775600000000();
        await expect(migration.down(qr)).resolves.not.toThrow();
        await qr.release();

        // Column should be gone
        const cols = await ds.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'worker_shares_entity'
              AND column_name = 'rejectedShares'
        `);
        expect(cols.length).toBe(0);

        await ds.destroy();
    });
});
