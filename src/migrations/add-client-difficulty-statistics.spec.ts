import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { ClientDifficultyStatisticsEntity } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.entity';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema';
import { UseTimestamptzForDates1707352800000 } from './1707352800000-UseTimestamptzForDates';
import { AddClientDifficultyStatistics1717430400000 } from './1717430400000-AddClientDifficultyStatistics';

describe('AddClientDifficultyStatistics1717430400000', () => {
    it('skips execution on sqlite connections', async () => {
        const dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            migrations: [AddClientDifficultyStatistics1717430400000],
            synchronize: true,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();
        await dataSource.destroy();
    });

    it('creates the hourly difficulty table with a unique index in postgres', async () => {
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
            entities: [ClientDifficultyStatisticsEntity],
            migrations: [
                InitialSchema1700000000000,
                UseTimestamptzForDates1707352800000,
                AddClientDifficultyStatistics1717430400000,
            ],
            synchronize: false,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();

        const [table] = (await dataSource.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
             AND table_name = 'client_difficulty_statistics_entity'`,
        )) as Array<{ table_name: string }>;

        expect(table?.table_name).toBe('client_difficulty_statistics_entity');

        const columns = (await dataSource.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name = 'client_difficulty_statistics_entity'
             ORDER BY ordinal_position`,
        )) as Array<{
            column_name: string;
            data_type: string;
            is_nullable: 'YES' | 'NO';
            column_default: string | null;
        }>;

        const columnMap = new Map(columns.map((column) => [column.column_name, column]));
        const timestamptzAliases = new Set(['timestamp with time zone', 'timestamptz']);

        expect(columnMap.has('id')).toBe(true);
        expect(columnMap.has('address')).toBe(true);
        expect(columnMap.has('clientName')).toBe(true);
        expect(columnMap.has('slotTime')).toBe(true);
        expect(columnMap.has('maxDifficulty')).toBe(true);
        expect(timestamptzAliases.has(columnMap.get('createdAt')?.data_type ?? '')).toBe(true);
        expect(timestamptzAliases.has(columnMap.get('updatedAt')?.data_type ?? '')).toBe(true);
        expect(timestamptzAliases.has(columnMap.get('deletedAt')?.data_type ?? '')).toBe(true);

        const repository = dataSource.getRepository(ClientDifficultyStatisticsEntity);

        await repository.insert({
            address: 'addr1',
            clientName: 'rig-1',
            slotTime: 1700000000,
            maxDifficulty: 42,
        });

        await expect(
            repository.insert({
                address: 'addr1',
                clientName: 'rig-1',
                slotTime: 1700000000,
                maxDifficulty: 99,
            }),
        ).rejects.toMatchObject({ code: '23505' });

        await dataSource.destroy();
    });
});
