import 'reflect-metadata';

import { DataType, newDb } from 'pg-mem';
import { DataSource } from 'typeorm';

import { AddressSettingsEntity } from '../ORM/address-settings/address-settings.entity';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientDifficultyStatisticsEntity } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.entity';
import { ClientEntity } from '../ORM/client/client.entity';
import { ExternalSharesEntity } from '../ORM/external-shares/external-shares.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { TelegramSubscriptionsEntity } from '../ORM/telegram-subscriptions/telegram-subscriptions.entity';
import { InitialSchema1700000000000 } from '../migrations/1700000000000-InitialSchema';
import { UseTimestamptzForDates1707352800000 } from '../migrations/1707352800000-UseTimestamptzForDates';
import { AddClientDifficultyStatistics1717430400000 } from '../migrations/1717430400000-AddClientDifficultyStatistics';
import { AddDeviceNotificationsToTelegramSubscriptions1718000000000 } from '../migrations/1718000000000-AddDeviceNotificationsToTelegramSubscriptions';
import { AddCurrentDifficultyToClients1719000000000 } from '../migrations/1719000000000-AddCurrentDifficultyToClients';
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
    MIGRATION_ENTITIES,
    MigrationLogger,
    migrateSqliteToPostgres,
    runAutomaticSqliteToPostgresMigration,
} from '../migration/sqlite-to-postgres';

/**
 * Inline migration: adds hourlyStatsEnabled and hourlyWorkersEnabled columns
 * to telegram_subscriptions_entity.  The entity defines them but no production
 * migration creates them on this table, so the pg-mem schema needs them.
 */
class AddHourlyColumnsToTelegramSubscriptions1719500000000 implements MigrationInterface {
    name = 'AddHourlyColumnsToTelegramSubscriptions1719500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;
        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ADD "hourlyStatsEnabled" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "telegram_subscriptions_entity"
            ADD "hourlyWorkersEnabled" boolean NOT NULL DEFAULT false
        `);
    }

    public async down(): Promise<void> { /* noop */ }
}
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('migrateSqliteToPostgres', () => {
    let sqliteDataSource: DataSource;
    let postgresDataSource: DataSource;

    class MemoryLogger implements MigrationLogger {
        public readonly infos: string[] = [];

        public readonly warnings: string[] = [];

        public readonly errors: string[] = [];

        info(message: string): void {
            this.infos.push(message);
        }

        warn(message: string): void {
            this.warnings.push(message);
        }

        error(message: string): void {
            this.errors.push(message);
        }
    }

    async function createSqliteDataSource(): Promise<DataSource> {
        const dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [...MIGRATION_ENTITIES],
            synchronize: true,
        });

        await dataSource.initialize();
        await seedSqliteDatabase(dataSource);
        return dataSource;
    }

    async function createPostgresDataSource(): Promise<DataSource> {
        const db = newDb({ autoCreateForeignKeyIndices: true });
        db.public.registerFunction({
            name: 'pg_get_serial_sequence',
            args: [DataType.text, DataType.text],
            returns: DataType.text,
            implementation: (table: string, column: string) => {
                const normalized = table.replace(/"/g, '');
                const tableName = normalized.includes('.') ? normalized.split('.')[1] : normalized;
                return `${tableName}_${column}_seq`;
            },
        });
        db.public.registerFunction({
            name: 'current_database',
            args: [],
            returns: DataType.text,
            implementation: () => 'pg-mem',
        });
        db.public.registerFunction({
            name: 'version',
            args: [],
            returns: DataType.text,
            implementation: () => 'PostgreSQL 14.0 (pg-mem)',
        });

        const dataSource = db.adapters.createTypeormDataSource({
            type: 'postgres',
            database: 'pg-mem',
            entities: [...MIGRATION_ENTITIES],
            migrations: [
                InitialSchema1700000000000,
                UseTimestamptzForDates1707352800000,
                AddClientDifficultyStatistics1717430400000,
                AddDeviceNotificationsToTelegramSubscriptions1718000000000,
                AddCurrentDifficultyToClients1719000000000,
                AddHourlyColumnsToTelegramSubscriptions1719500000000,
            ],
            synchronize: false,
        });

        await dataSource.initialize();
        await dataSource.runMigrations();
        return dataSource;
    }

    async function seedSqliteDatabase(dataSource: DataSource): Promise<void> {
        const now = new Date('2024-01-01T00:00:00.000Z');

        await dataSource.getRepository(AddressSettingsEntity).save({
            address: 'addr1',
            shares: 42,
            bestDifficulty: 123.456,
            miscCoinbaseScriptData: 'coinbase',
            bestDifficultyUserAgent: 'best-ua',
            createdAt: now,
            updatedAt: now,
        });

        const client = await dataSource.getRepository(ClientEntity).save({
            address: 'addr1',
            clientName: 'rig-1',
            sessionId: 'sessionA',
            userAgent: 'ua/1.0',
            startTime: now,
            firstSeen: now,
            bestDifficulty: 10.5,
            hashRate: 123,
            currentDifficulty: 512,
        });

        await dataSource.getRepository(ClientStatisticsEntity).save({
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId,
            time: 1700000000,
            shares: 15.5,
            acceptedCount: 12,
            rejectedCount: 1,
            rejectedJobNotFoundCount: 1,
            rejectedJobNotFoundDiff1: 0.1,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
        });

        await dataSource.getRepository(ClientDifficultyStatisticsEntity).save({
            address: client.address,
            clientName: client.clientName,
            slotTime: 1700000000,
            maxDifficulty: 321.123,
        });

        await dataSource.getRepository(ClientRejectedStatisticsEntity).save({
            address: client.address,
            time: 1700000000,
            reason: 'Duplicate share',
            count: 2,
            shares: 0.2,
        });

        await dataSource.getRepository(ExternalSharesEntity).save({
            address: client.address,
            clientName: client.clientName,
            time: 1700000000,
            difficulty: 19.5,
            userAgent: 'external-ua',
            externalPoolName: 'extPool',
            header: 'header-data',
        });

        await dataSource.getRepository(PoolRejectedStatisticsEntity).save({
            time: 1700000000,
            reason: 'Low diff',
            count: 3,
        });

        await dataSource.getRepository(PoolShareStatisticsEntity).save({
            time: 1700000000,
            accepted: 111,
            rejected: 2,
        });

        await dataSource.getRepository(BlocksEntity).save({
            height: 780000,
            minerAddress: 'addr1',
            worker: 'rig-1',
            sessionId: 'sessionA',
            blockData: 'block-hex',
        });

        const telegramRepo = dataSource.getRepository(TelegramSubscriptionsEntity);
        const telegram = await telegramRepo.save({
            address: 'addr1',
            telegramChatId: 123456,
            bestDiffNotificationsEnabled: true,
            isDefault: false,
        });
        await telegramRepo.softDelete(telegram.id);
    }

    async function computeEntityCounts(dataSource: DataSource): Promise<Map<string, number>> {
        const counts = new Map<string, number>();

        for (const entity of MIGRATION_ENTITIES) {
            const metadata = dataSource.getMetadata(entity);
            const query = dataSource.getRepository(entity).createQueryBuilder('row');
            if (metadata.deleteDateColumn) {
                query.withDeleted();
            }

            const count = await query.getCount();
            counts.set(metadata.tableName, count);
        }

        return counts;
    }

    async function createFileBackedSqliteDatabase(): Promise<{ path: string; cleanup: () => Promise<void>; counts: Map<string, number> }> {
        const directory = await fs.mkdtemp(join(tmpdir(), 'blitzpool-sqlite-'));
        const databasePath = join(directory, 'public-pool.sqlite');
        const fileDataSource = new DataSource({
            type: 'sqlite',
            database: databasePath,
            entities: [...MIGRATION_ENTITIES],
            synchronize: true,
        });

        await fileDataSource.initialize();
        await seedSqliteDatabase(fileDataSource);
        const counts = await computeEntityCounts(fileDataSource);
        await fileDataSource.destroy();

        return {
            path: databasePath,
            counts,
            cleanup: async () => {
                await fs.rm(directory, { recursive: true, force: true });
            },
        };
    }

    beforeEach(async () => {
        sqliteDataSource = await createSqliteDataSource();
        postgresDataSource = await createPostgresDataSource();
    });

    afterEach(async () => {
        if (sqliteDataSource?.isInitialized) {
            await sqliteDataSource.destroy();
        }

        if (postgresDataSource?.isInitialized) {
            await postgresDataSource.destroy();
        }
    });

    it('copies all rows to Postgres and maintains generated sequences', async () => {
        const logger = new MemoryLogger();

        const summary = await migrateSqliteToPostgres(
            sqliteDataSource,
            postgresDataSource,
            { batchSize: 2, skipSequenceReset: true },
            logger,
        );

        for (const entity of MIGRATION_ENTITIES) {
            const sqliteMetadata = sqliteDataSource.getMetadata(entity);
            const sqliteQuery = sqliteDataSource.getRepository(entity).createQueryBuilder('row');
            if (sqliteMetadata.deleteDateColumn) {
                sqliteQuery.withDeleted();
            }
            const sqliteCount = await sqliteQuery.getCount();

            const postgresMetadata = postgresDataSource.getMetadata(entity);
            const postgresQuery = postgresDataSource.getRepository(entity).createQueryBuilder('row');
            if (postgresMetadata.deleteDateColumn) {
                postgresQuery.withDeleted();
            }
            const postgresCount = await postgresQuery.getCount();

            expect(postgresCount).toBe(sqliteCount);
        }

        const migratedClient = await postgresDataSource.getRepository(ClientEntity).findOneByOrFail({
            address: 'addr1',
            clientName: 'rig-1',
            sessionId: 'sessionA',
        });
        expect(migratedClient.firstSeen?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(migratedClient.hashRate).toBe(123);
        expect(migratedClient.currentDifficulty).toBe(512);

        const telegramSubscription = await postgresDataSource
            .getRepository(TelegramSubscriptionsEntity)
            .createQueryBuilder('subscription')
            .withDeleted()
            .where('subscription.address = :address', { address: 'addr1' })
            .getOneOrFail();
        expect(telegramSubscription.deletedAt).not.toBeNull();

        const blocksRepository = postgresDataSource.getRepository(BlocksEntity);
        const newBlock = await blocksRepository.save({
            height: 780001,
            minerAddress: 'addr2',
            worker: 'rig-2',
            sessionId: 'sessionB',
            blockData: 'block-hex-2',
        });
        expect(newBlock.id).toBeGreaterThan(1);

        expect(logger.errors).toHaveLength(0);
        expect(logger.warnings).toHaveLength(0);
        expect(summary.didRun).toBe(true);
        expect(summary.migratedRows).toBeGreaterThan(0);
    });

    it('supports dry-run mode without modifying Postgres', async () => {
        const logger = new MemoryLogger();

        const summary = await migrateSqliteToPostgres(
            sqliteDataSource,
            postgresDataSource,
            { dryRun: true, skipSequenceReset: true },
            logger,
        );

        for (const entity of MIGRATION_ENTITIES) {
            const count = await postgresDataSource.getRepository(entity).count();
            expect(count).toBe(0);
        }

        expect(logger.errors).toHaveLength(0);
        expect(summary.didRun).toBe(true);
        expect(summary.migratedRows).toBeGreaterThan(0);
        expect(summary.skipReason).toBeUndefined();
    });

    describe('runAutomaticSqliteToPostgresMigration', () => {
        it('copies rows when the target is empty and skips once populated', async () => {
            const logger = new MemoryLogger();
            const { path, cleanup, counts: sqliteCounts } = await createFileBackedSqliteDatabase();

            try {
                const firstRun = await runAutomaticSqliteToPostgresMigration(postgresDataSource, {
                    sqlitePath: path,
                    logger,
                });

                expect(firstRun.didRun).toBe(true);
                expect(firstRun.skipReason).toBeUndefined();
                expect(firstRun.migratedRows).toBeGreaterThan(0);

                const postgresCounts = await computeEntityCounts(postgresDataSource);
                for (const [tableName, expectedCount] of sqliteCounts.entries()) {
                    expect(postgresCounts.get(tableName)).toBe(expectedCount);
                }

                const secondRun = await runAutomaticSqliteToPostgresMigration(postgresDataSource, {
                    sqlitePath: path,
                    logger,
                });

                expect(secondRun.didRun).toBe(false);
                expect(secondRun.skipReason).toBe('target-not-empty');
                expect(secondRun.migratedRows).toBe(0);

                const postSecondCounts = await computeEntityCounts(postgresDataSource);
                for (const [tableName, expectedCount] of sqliteCounts.entries()) {
                    expect(postSecondCounts.get(tableName)).toBe(expectedCount);
                }

                const clientTable = postgresDataSource.getMetadata(ClientEntity).tableName;
                expect(postSecondCounts.get(clientTable)).toBe(sqliteCounts.get(clientTable));

                expect(logger.errors).toHaveLength(0);
            } finally {
                await cleanup();
            }
        });

        it('skips automatically when the SQLite file is missing', async () => {
            const logger = new MemoryLogger();
            const missingPath = join(tmpdir(), 'non-existent', 'public-pool.sqlite');

            const summary = await runAutomaticSqliteToPostgresMigration(postgresDataSource, {
                sqlitePath: missingPath,
                logger,
            });

            expect(summary.didRun).toBe(false);
            expect(summary.skipReason).toBe('sqlite-not-found');
            expect(summary.migratedRows).toBe(0);

            for (const entity of MIGRATION_ENTITIES) {
                const count = await postgresDataSource.getRepository(entity).count();
                expect(count).toBe(0);
            }

            expect(logger.errors).toHaveLength(0);
        });
    });
});
