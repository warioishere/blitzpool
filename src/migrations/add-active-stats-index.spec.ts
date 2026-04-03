import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { InitialSchema1700000000000 } from './1700000000000-InitialSchema';
import { AddActiveStatsIndex1775400000000 } from './1775400000000-AddActiveStatsIndex';

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

    // Only InitialSchema is needed — it creates client_statistics_entity.
    // Intermediate migrations are omitted because some use HAVING clauses
    // that pg-mem does not support and are not relevant to this index.
    return db.adapters.createTypeormDataSource({
        type: 'postgres',
        database: 'pg-mem',
        entities: [],
        migrations: [
            InitialSchema1700000000000,
            AddActiveStatsIndex1775400000000,
        ],
        synchronize: false,
    });
}

describe('AddActiveStatsIndex1775400000000', () => {
    it('skips execution on sqlite', async () => {
        const ds = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            migrations: [AddActiveStatsIndex1775400000000],
            synchronize: true,
        });
        await ds.initialize();
        await ds.runMigrations();
        await ds.destroy();
    });

    it('runs without error and is reported as executed', async () => {
        const ds = buildPgMemDataSource();
        await ds.initialize();

        // runMigrations() throws if the SQL is invalid
        const executed = await ds.runMigrations();

        const names = executed.map(m => m.name);
        expect(names).toContain('AddActiveStatsIndex1775400000000');

        await ds.destroy();
    });

    it('down migration runs without error', async () => {
        const ds = buildPgMemDataSource();
        await ds.initialize();
        await ds.runMigrations();

        // undoLastMigration() throws if DROP INDEX fails
        await expect(ds.undoLastMigration()).resolves.not.toThrow();

        await ds.destroy();
    });
});
