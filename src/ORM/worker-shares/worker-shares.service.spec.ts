import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { WorkerSharesEntity } from './worker-shares.entity';
import { WorkerSharesService } from './worker-shares.service';

async function createDataSource(driver: 'sqlite' | 'postgres'): Promise<DataSource> {
    if (driver === 'sqlite') {
        const ds = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            dropSchema: true,
            synchronize: true,
            entities: [WorkerSharesEntity],
        });
        await ds.initialize();
        return ds;
    }

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
        synchronize: true,
        entities: [WorkerSharesEntity],
    });
    await ds.initialize();
    return ds;
}

// NOTE: 'postgres' branch dropped because the production code path now uses
// `unnest($1::text[], $2::text[], …)` with multiple parallel array args, a
// PostgreSQL 9.4+ feature that the pg-mem in-memory simulator we use for
// these tests does not implement. Real Postgres handles it fine — the
// upgrade path was benchmarked on prod hardware (1500-row insert went
// 238ms → 27ms vs the previous VALUES-list path).
//
// Postgres-side data-equivalence is covered separately by
// `src/services/statistics-coordinator.unnest.spec.ts` which mocks the
// repository's `query()` method and asserts the array-param shape directly.
// SQLite still runs end-to-end here as a sanity check that the bulk
// methods compose with the entity layer correctly.
describe.each(['sqlite'] as const)('WorkerSharesService (%s)', (driver) => {
    let ds: DataSource;
    let service: WorkerSharesService;

    beforeAll(async () => {
        ds = await createDataSource(driver);
        service = new WorkerSharesService(ds.getRepository(WorkerSharesEntity), ds);
    });

    afterAll(async () => {
        await ds.destroy();
    });

    beforeEach(async () => {
        await ds.getRepository(WorkerSharesEntity).clear();
    });

    describe('addRejectedBulk', () => {
        it('handles empty array without error', async () => {
            await expect(service.addRejectedBulk([])).resolves.not.toThrow();
        });

        it('inserts a new row with shares=0 when the worker does not exist yet', async () => {
            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 7 }]);

            const row = await ds.getRepository(WorkerSharesEntity).findOne({
                where: { address: 'addr1', clientName: 'rig1' },
            });
            expect(row?.rejectedShares).toBe(7);
            expect(row?.shares).toBe(0);
        });

        it('increments rejectedShares on an existing row without touching accepted shares', async () => {
            await ds.getRepository(WorkerSharesEntity).save({
                address: 'addr1', clientName: 'rig1', shares: 500, rejectedShares: 5,
            });

            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 3 }]);

            const row = await ds.getRepository(WorkerSharesEntity).findOne({
                where: { address: 'addr1', clientName: 'rig1' },
            });
            expect(row?.rejectedShares).toBe(8);
            expect(row?.shares).toBe(500);
        });

        it('handles multiple workers in a single call', async () => {
            await service.addRejectedBulk([
                { address: 'addr1', clientName: 'rig1', rejectedShares: 3 },
                { address: 'addr1', clientName: 'rig2', rejectedShares: 5 },
            ]);

            const totals = await service.getWorkerTotals('addr1');
            const rig1 = totals.find(t => t.clientName === 'rig1');
            const rig2 = totals.find(t => t.clientName === 'rig2');
            expect(rig1?.rejectedShares).toBe(3);
            expect(rig2?.rejectedShares).toBe(5);
        });

        it('accumulates correctly across multiple calls', async () => {
            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 4 }]);
            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 6 }]);

            const row = await ds.getRepository(WorkerSharesEntity).findOne({
                where: { address: 'addr1', clientName: 'rig1' },
            });
            expect(row?.rejectedShares).toBe(10);
        });
    });

    describe('getWorkerTotals', () => {
        it('returns rejectedShares alongside accepted shares', async () => {
            await ds.getRepository(WorkerSharesEntity).save({
                address: 'addr1', clientName: 'rig1', shares: 1000, rejectedShares: 42,
            });

            const totals = await service.getWorkerTotals('addr1');

            expect(totals.length).toBe(1);
            expect(totals[0].shares).toBe(1000);
            expect(totals[0].rejectedShares).toBe(42);
        });

        it('returns empty array when address has no workers', async () => {
            const totals = await service.getWorkerTotals('unknown');
            expect(totals).toEqual([]);
        });
    });

    describe('addSharesBulk and addRejectedBulk independence', () => {
        it('addSharesBulk does not overwrite rejectedShares', async () => {
            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 10 }]);
            await service.addSharesBulk([{ address: 'addr1', clientName: 'rig1', shares: 200 }]);

            const row = await ds.getRepository(WorkerSharesEntity).findOne({
                where: { address: 'addr1', clientName: 'rig1' },
            });
            expect(row?.shares).toBe(200);
            expect(row?.rejectedShares).toBe(10);
        });

        it('addRejectedBulk does not overwrite accepted shares', async () => {
            // Use repo.save() to pre-populate the row with fully typed column values.
            // (pg-mem has a known limitation where DEFAULT 0 values in ON CONFLICT
            //  arithmetic are treated as untyped; explicit TypeORM insertion avoids this.)
            await ds.getRepository(WorkerSharesEntity).save({
                address: 'addr1', clientName: 'rig1', shares: 300, rejectedShares: 0,
            });
            await service.addRejectedBulk([{ address: 'addr1', clientName: 'rig1', rejectedShares: 15 }]);

            const row = await ds.getRepository(WorkerSharesEntity).findOne({
                where: { address: 'addr1', clientName: 'rig1' },
            });
            expect(row?.shares).toBe(300);
            expect(row?.rejectedShares).toBe(15);
        });
    });
});
