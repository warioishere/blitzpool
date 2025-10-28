import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { ClientEntity } from '../ORM/client/client.entity';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema';
import { UseTimestamptzForDates1707352800000 } from './1707352800000-UseTimestamptzForDates';
import { AddCurrentDifficultyToClients1719000000000 } from './1719000000000-AddCurrentDifficultyToClients';

describe('AddCurrentDifficultyToClients1719000000000', () => {
    it('adds the column on sqlite', async () => {
        const dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [ClientEntity],
            migrations: [AddCurrentDifficultyToClients1719000000000],
            synchronize: true,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();
        await dataSource.destroy();
    });

    it('adds the column on postgres', async () => {
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

        const dataSource = db.adapters.createTypeormDataSource({
            type: 'postgres',
            database: 'pg-mem',
            entities: [ClientEntity],
            migrations: [
                InitialSchema1700000000000,
                UseTimestamptzForDates1707352800000,
                AddCurrentDifficultyToClients1719000000000,
            ],
            synchronize: false,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();

        const columns = (await dataSource.query(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_name = 'client_entity'
             AND column_name = 'currentDifficulty'`,
        )) as Array<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>; 

        expect(columns).toHaveLength(1);
        expect(['double precision', 'real', 'float4']).toContain(columns[0]?.data_type);
        expect(columns[0]?.is_nullable).toBe('YES');

        await dataSource.destroy();
    });
});
