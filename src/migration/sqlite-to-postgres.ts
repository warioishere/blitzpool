import 'reflect-metadata';

import { existsSync } from 'fs';
import {
    DataSource,
    DeepPartial,
    EntityMetadata,
    EntityTarget,
} from 'typeorm';

import { AddressSettingsEntity } from '../ORM/address-settings/address-settings.entity';
import { BestDifficultyTrackerEntity } from '../ORM/best-difficulty-tracker/best-difficulty-tracker.entity';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientDifficultyStatisticsEntity } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.entity';
import { ClientEntity } from '../ORM/client/client.entity';
import { ExternalSharesEntity } from '../ORM/external-shares/external-shares.entity';
import { NetworkDifficultyTrackerEntity } from '../ORM/network-difficulty-tracker/network-difficulty-tracker.entity';
import { NtfySubscriptionsEntity } from '../ORM/ntfy-subscriptions/ntfy-subscriptions.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { PushSubscriptionEntity } from '../ORM/push-subscriptions/push-subscription.entity';
import { RpcBlockEntity } from '../ORM/rpc-block/rpc-block.entity';
import { TelegramSubscriptionsEntity } from '../ORM/telegram-subscriptions/telegram-subscriptions.entity';

export const DEFAULT_SQLITE_PATH = './DB/public-pool.sqlite';

export const MIGRATION_ENTITIES = [
    AddressSettingsEntity,
    BestDifficultyTrackerEntity,
    BlocksEntity,
    ClientEntity,
    ClientRejectedStatisticsEntity,
    ClientStatisticsEntity,
    ClientDifficultyStatisticsEntity,
    ExternalSharesEntity,
    NetworkDifficultyTrackerEntity,
    NtfySubscriptionsEntity,
    PoolRejectedStatisticsEntity,
    PoolShareStatisticsEntity,
    PushSubscriptionEntity,
    TelegramSubscriptionsEntity,
    RpcBlockEntity,
] as const satisfies readonly EntityTarget<unknown>[];

type MigrationEntity = (typeof MIGRATION_ENTITIES)[number];

export interface MigrationLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

const defaultLogger: MigrationLogger = {
    info(message: string): void {
        console.log(message);
    },
    warn(message: string): void {
        console.warn(message);
    },
    error(message: string, error?: unknown): void {
        console.error(message, error);
    },
};

export interface MigrationOptions {
    batchSize?: number;
    dryRun?: boolean;
    skipSequenceReset?: boolean;
    skipIfTargetHasData?: boolean;
}

export interface MigrationSummary {
    didRun: boolean;
    migratedRows: number;
    skipReason?: 'target-not-empty';
}

export interface AutomaticMigrationOptions extends MigrationOptions {
    sqlitePath?: string;
    logger?: MigrationLogger;
    /** Called after pre-flight checks pass but before data is copied. */
    beforeMigration?: () => Promise<void>;
}

export interface AutomaticMigrationSummary extends Omit<MigrationSummary, 'skipReason'> {
    sqlitePath: string;
    skipReason?: 'sqlite-not-found' | 'target-not-empty';
}

const DEFAULT_BATCH_SIZE = 500;

function normalizeBatchSize(batchSize: number | undefined): number {
    if (!batchSize || Number.isNaN(batchSize) || batchSize <= 0) {
        return DEFAULT_BATCH_SIZE;
    }

    return Math.floor(batchSize);
}

function quoteIdentifier(identifier: string): string {
    return identifier
        .split('.')
        .map((part) => `"${part.replace(/"/g, '""')}"`)
        .join('.');
}

function extractPlainRecords<T>(metadata: EntityMetadata, rows: T[]): DeepPartial<T>[] {
    return rows.map((row) => {
        const plain: Record<string, unknown> = {};

        for (const column of metadata.columns) {
            plain[column.propertyName] = column.getEntityValue(row as object);
        }

        return plain as DeepPartial<T>;
    });
}

function buildOrderBy(metadata: EntityMetadata): Record<string, 'ASC'> {
    const alias = 'row';
    const orderBy: Record<string, 'ASC'> = {};
    const primaryColumns = metadata.primaryColumns.length > 0 ? metadata.primaryColumns : metadata.columns;

    for (const column of primaryColumns) {
        orderBy[`${alias}.${column.propertyName}`] = 'ASC';
    }

    return orderBy;
}

async function migrateEntity(
    sqliteDataSource: DataSource,
    postgresDataSource: DataSource,
    entity: MigrationEntity,
    batchSize: number,
    dryRun: boolean,
    logger: MigrationLogger,
): Promise<number> {
    const sqliteMetadata = sqliteDataSource.getMetadata(entity);
    const postgresMetadata = postgresDataSource.getMetadata(entity);
    const tableLabel = postgresMetadata.tableName;
    const repository = sqliteDataSource.getRepository(entity);
    const baseQuery = repository.createQueryBuilder('row');

    if (sqliteMetadata.deleteDateColumn) {
        baseQuery.withDeleted();
    }

    const total = await baseQuery.clone().getCount();

    if (total === 0) {
        logger.info(`[${tableLabel}] No rows found, skipping.`);
        return 0;
    }

    logger.info(`[${tableLabel}] Migrating ${total} rows${dryRun ? ' (dry-run)' : ''}...`);

    const orderBy = buildOrderBy(sqliteMetadata);
    let offset = 0;
    let migrated = 0;

    while (true) {
        const batch = await baseQuery
            .clone()
            .orderBy(orderBy)
            .skip(offset)
            .take(batchSize)
            .getMany();

        if (batch.length === 0) {
            break;
        }

        migrated += batch.length;
        offset += batch.length;

        if (!dryRun) {
            const plainRecords = extractPlainRecords(sqliteMetadata, batch);
            await postgresDataSource.transaction(async (manager) => {
                const targetRepository = manager.getRepository(entity);
                const entitiesToSave = plainRecords.map((record) => targetRepository.create(record));
                await targetRepository.save(entitiesToSave, { chunk: Math.min(batchSize, 1000) });
            });
        }

        logger.info(`[${tableLabel}] Processed ${migrated}/${total} rows.`);
    }

    return migrated;
}

async function resetSequences(
    postgresDataSource: DataSource,
    entities: readonly EntityTarget<unknown>[],
    logger: MigrationLogger,
): Promise<void> {
    if (postgresDataSource.options.type !== 'postgres') {
        logger.info('Skipping sequence reset because target database is not Postgres.');
        return;
    }

    const queryRunner = postgresDataSource.createQueryRunner();

    try {
        for (const entity of entities) {
            const metadata = postgresDataSource.getMetadata(entity);
            const generatedColumns = metadata.columns.filter(
                (column) => column.isGenerated && column.generationStrategy === 'increment',
            );

            if (generatedColumns.length === 0) {
                continue;
            }

            const tablePath = metadata.tablePath;
            const quotedTable = quoteIdentifier(tablePath);

            for (const column of generatedColumns) {
                const quotedColumn = quoteIdentifier(column.databaseName);

                try {
                    const [{ max }] = await queryRunner.query(
                        `SELECT COALESCE(MAX(${quotedColumn}), 0) AS max FROM ${quotedTable}`,
                    );
                    const maxValue = Number(max) || 0;
                    const nextValue = maxValue > 0 ? maxValue + 1 : 1;

                    try {
                        await queryRunner.query(`SELECT setval(pg_get_serial_sequence($1, $2), $3, false)`, [
                            tablePath,
                            column.databaseName,
                            nextValue,
                        ]);
                        logger.info(
                            `[${metadata.tableName}] Sequence for column ${column.databaseName} set to next value ${nextValue}.`,
                        );
                    } catch (setvalError) {
                        try {
                            const [{ seq }] = await queryRunner.query(
                                `SELECT pg_get_serial_sequence($1, $2) AS seq`,
                                [tablePath, column.databaseName],
                            );

                            if (!seq) {
                                throw new Error('Sequence name could not be resolved');
                            }

                            await queryRunner.query(
                                `ALTER SEQUENCE ${quoteIdentifier(seq)} RESTART WITH ${nextValue}`,
                            );
                            logger.info(
                                `[${metadata.tableName}] Sequence for column ${column.databaseName} restarted at ${nextValue}.`,
                            );
                        } catch (fallbackError) {
                            const errorMessage =
                                fallbackError instanceof Error
                                    ? fallbackError.message
                                    : setvalError instanceof Error
                                        ? setvalError.message
                                        : String(fallbackError);
                            logger.warn(
                                `[${metadata.tableName}] Unable to adjust sequence for column ${column.databaseName}: ${errorMessage}`,
                            );
                        }
                    }
                } catch (error) {
                    logger.warn(
                        `[${metadata.tableName}] Unable to compute next sequence value for column ${column.databaseName}: ${(error as Error).message}`,
                    );
                }
            }
        }
    } finally {
        await queryRunner.release();
    }
}

async function targetHasExistingData(postgresDataSource: DataSource): Promise<boolean> {
    for (const entity of MIGRATION_ENTITIES) {
        const metadata = postgresDataSource.getMetadata(entity);
        const repository = postgresDataSource.getRepository(entity);
        const query = repository.createQueryBuilder('row');
        if (metadata.deleteDateColumn) {
            query.withDeleted();
        }

        const count = await query.clone().limit(1).getCount();

        if (count > 0) {
            return true;
        }
    }

    return false;
}

export async function migrateSqliteToPostgres(
    sqliteDataSource: DataSource,
    postgresDataSource: DataSource,
    options: MigrationOptions = {},
    logger: MigrationLogger = defaultLogger,
): Promise<MigrationSummary> {
    const batchSize = normalizeBatchSize(options.batchSize);
    const dryRun = options.dryRun ?? false;
    const skipSequenceReset = options.skipSequenceReset ?? false;
    const skipIfTargetHasData = options.skipIfTargetHasData ?? false;

    if (!sqliteDataSource.isInitialized) {
        await sqliteDataSource.initialize();
    }

    if (!postgresDataSource.isInitialized) {
        await postgresDataSource.initialize();
    }

    if (!dryRun && skipIfTargetHasData) {
        const alreadyHasData = await targetHasExistingData(postgresDataSource);
        if (alreadyHasData) {
            logger.info('Target Postgres database already contains data. Skipping migration.');
            return { didRun: false, migratedRows: 0, skipReason: 'target-not-empty' };
        }
    }

    logger.info(
        `Starting migration from SQLite to Postgres using batch size ${batchSize}${dryRun ? ' (dry-run mode)' : ''}.`,
    );

    let totalMigrated = 0;

    for (const entity of MIGRATION_ENTITIES) {
        totalMigrated += await migrateEntity(
            sqliteDataSource,
            postgresDataSource,
            entity,
            batchSize,
            dryRun,
            logger,
        );
    }

    if (!dryRun && !skipSequenceReset) {
        await resetSequences(postgresDataSource, MIGRATION_ENTITIES, logger);
    } else if (!dryRun && skipSequenceReset) {
        logger.info('Skipping sequence reset because skipSequenceReset option is enabled.');
    } else {
        logger.info('Dry-run complete. No data was written to Postgres.');
    }

    logger.info('Migration finished.');

    return { didRun: true, migratedRows: totalMigrated };
}

export async function runAutomaticSqliteToPostgresMigration(
    postgresDataSource: DataSource,
    options: AutomaticMigrationOptions = {},
): Promise<AutomaticMigrationSummary> {
    const logger = options.logger ?? defaultLogger;
    const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
    const { logger: _ignoredLogger, sqlitePath: _ignoredPath, beforeMigration, ...migrationOptions } = options;

    if (!existsSync(sqlitePath)) {
        logger.info(`SQLite database not found at path ${sqlitePath}. Skipping automatic migration.`);
        return { didRun: false, migratedRows: 0, skipReason: 'sqlite-not-found', sqlitePath };
    }

    // Check if target already has data before running beforeMigration hook
    const skipIfTargetHasData = options.skipIfTargetHasData ?? true;
    if (skipIfTargetHasData) {
        const alreadyHasData = await targetHasExistingData(postgresDataSource);
        if (alreadyHasData) {
            logger.info('Target Postgres database already contains data. Skipping migration.');
            return { didRun: false, migratedRows: 0, skipReason: 'target-not-empty', sqlitePath };
        }
    }

    if (beforeMigration) {
        await beforeMigration();
    }

    const sqliteDataSource = new DataSource({
        type: 'sqlite',
        database: sqlitePath,
        entities: [...MIGRATION_ENTITIES],
        logging: false,
    });

    try {
        const summary = await migrateSqliteToPostgres(
            sqliteDataSource,
            postgresDataSource,
            { ...migrationOptions, skipIfTargetHasData: false },
            logger,
        );

        return { ...summary, sqlitePath };
    } finally {
        if (sqliteDataSource.isInitialized) {
            await sqliteDataSource.destroy();
        }
    }
}
