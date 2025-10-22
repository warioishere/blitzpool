import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { AddressSettingsEntity } from '../ORM/address-settings/address-settings.entity';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientEntity } from '../ORM/client/client.entity';
import { ExternalSharesEntity } from '../ORM/external-shares/external-shares.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { TelegramSubscriptionsEntity } from '../ORM/telegram-subscriptions/telegram-subscriptions.entity';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema';
import { UseTimestamptzForDates1707352800000 } from './1707352800000-UseTimestamptzForDates';

const ENTITIES = [
    AddressSettingsEntity,
    BlocksEntity,
    ClientEntity,
    ClientRejectedStatisticsEntity,
    ClientStatisticsEntity,
    ExternalSharesEntity,
    PoolRejectedStatisticsEntity,
    PoolShareStatisticsEntity,
    TelegramSubscriptionsEntity,
];

const TRACKED_TABLES = [
    'address_settings_entity',
    'blocks_entity',
    'client_entity',
    'client_rejected_statistics_entity',
    'client_statistics_entity',
    'external_shares_entity',
    'pool_rejected_statistics_entity',
    'pool_share_statistics_entity',
    'telegram_subscriptions_entity',
];

describe('UseTimestamptzForDates1707352800000', () => {
    it('runs without changes on sqlite', async () => {
        const dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            dropSchema: true,
            entities: ENTITIES,
            migrations: [UseTimestamptzForDates1707352800000],
            synchronize: true,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();
        await dataSource.destroy();
    });

    it('converts tracked columns to timestamptz in postgres', async () => {
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
            entities: ENTITIES,
            migrations: [InitialSchema1700000000000, UseTimestamptzForDates1707352800000],
            synchronize: false,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();

        const tablePlaceholders = TRACKED_TABLES.map((_, index) => `$${index + 1}`).join(', ');
        const trackedColumns = (await dataSource.query(
            `SELECT table_name, column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name IN (${tablePlaceholders})
             AND column_name IN ('createdAt', 'updatedAt', 'deletedAt')
            `,
            TRACKED_TABLES,
        )) as Array<{
            table_name: string;
            column_name: string;
            data_type: string;
            is_nullable: 'YES' | 'NO';
            column_default: string | null;
        }>;

        expect(trackedColumns).not.toHaveLength(0);
        const timestamptzAliases = new Set(['timestamp with time zone', 'timestamptz']);
        trackedColumns.forEach((column) => {
            expect(timestamptzAliases.has(column.data_type)).toBe(true);
            if (column.column_name === 'deletedAt') {
                if (dataSource.options.database !== 'pg-mem') {
                    expect(column.is_nullable).toBe('YES');
                }
            } else {
                const defaultValue = column.column_default ?? '';
                if (dataSource.options.database === 'pg-mem') {
                    expect(defaultValue).toBe('');
                } else {
                    expect(defaultValue.includes('now') || defaultValue.includes('CURRENT_TIMESTAMP')).toBe(true);
                }
            }
        });

        const clientColumns = (await dataSource.query(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_name = 'client_entity'
             AND column_name IN ('startTime', 'firstSeen')
            `,
        )) as Array<{
            column_name: string;
            data_type: string;
            is_nullable: 'YES' | 'NO';
        }>;

        expect(clientColumns).toHaveLength(2);
        clientColumns.forEach((column) => {
            expect(timestamptzAliases.has(column.data_type)).toBe(true);
            if (dataSource.options.database !== 'pg-mem') {
                if (column.column_name === 'startTime') {
                    expect(column.is_nullable).toBe('NO');
                } else {
                    expect(column.is_nullable).toBe('YES');
                }
            }
        });

        await dataSource.destroy();
    });
});
