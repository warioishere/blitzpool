import 'reflect-metadata';

import { existsSync } from 'fs';
import {
    DataSource,
    DeepPartial,
    EntityMetadata,
    EntityTarget,
} from 'typeorm';

import { AddressSettingsEntity } from '../src/ORM/address-settings/address-settings.entity';
import { BlocksEntity } from '../src/ORM/blocks/blocks.entity';
import { ClientRejectedStatisticsEntity } from '../src/ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from '../src/ORM/client-statistics/client-statistics.entity';
import { ClientEntity } from '../src/ORM/client/client.entity';
import { ExternalSharesEntity } from '../src/ORM/external-shares/external-shares.entity';
import { PoolRejectedStatisticsEntity } from '../src/ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from '../src/ORM/pool-share-statistics/pool-share-statistics.entity';
import { RpcBlockEntity } from '../src/ORM/rpc-block/rpc-block.entity';
import { TelegramSubscriptionsEntity } from '../src/ORM/telegram-subscriptions/telegram-subscriptions.entity';

export const MIGRATION_ENTITIES = [
    AddressSettingsEntity,
    BlocksEntity,
    ClientEntity,
    ClientRejectedStatisticsEntity,
    ClientStatisticsEntity,
    ExternalSharesEntity,
    PoolRejectedStatisticsEntity,
    PoolShareStatisticsEntity,
    TelegramSubscriptionsEntity,
    RpcBlockEntity,
] as const satisfies readonly EntityTarget<unknown>[];

type MigrationEntity = (typeof MIGRATION_ENTITIES)[number];

export interface MigrationLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

export interface MigrationOptions {
    batchSize?: number;
    dryRun?: boolean;
    skipSequenceReset?: boolean;
}

interface PostgresConnectionOptions {
    host: string;
    port: number;
    username: string;
    password?: string;
    database: string;
    ssl?: boolean;
}

type ArgValue = string | boolean;
type ArgMap = Record<string, ArgValue>;

const DEFAULT_SQLITE_PATH = './DB/public-pool.sqlite';
const DEFAULT_BATCH_SIZE = 500;

const defaultLogger: MigrationLogger = {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string, error?: unknown) => {
        if (error) {
            console.error(message, error);
            return;
        }
        console.error(message);
    },
};

function normalizeBatchSize(value?: number): number {
    if (!value || Number.isNaN(value) || value <= 0) {
        return DEFAULT_BATCH_SIZE;
    }

    return Math.floor(value);
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
): Promise<void> {
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
        return;
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
}

async function resetSequences(
    postgresDataSource: DataSource,
    entities: readonly MigrationEntity[],
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

export async function migrateSqliteToPostgres(
    sqliteDataSource: DataSource,
    postgresDataSource: DataSource,
    options: MigrationOptions = {},
    logger: MigrationLogger = defaultLogger,
): Promise<void> {
    const batchSize = normalizeBatchSize(options.batchSize);
    const dryRun = options.dryRun ?? false;
    const skipSequenceReset = options.skipSequenceReset ?? false;

    if (!sqliteDataSource.isInitialized) {
        await sqliteDataSource.initialize();
    }

    if (!postgresDataSource.isInitialized) {
        await postgresDataSource.initialize();
    }

    logger.info(
        `Starting migration from SQLite to Postgres using batch size ${batchSize}${dryRun ? ' (dry-run mode)' : ''}.`,
    );

    for (const entity of MIGRATION_ENTITIES) {
        await migrateEntity(sqliteDataSource, postgresDataSource, entity, batchSize, dryRun, logger);
    }

    if (!dryRun && !skipSequenceReset) {
        await resetSequences(postgresDataSource, MIGRATION_ENTITIES, logger);
    } else if (!dryRun && skipSequenceReset) {
        logger.info('Skipping sequence reset because skipSequenceReset option is enabled.');
    } else {
        logger.info('Dry-run complete. No data was written to Postgres.');
    }

    logger.info('Migration finished.');
}

function parseArgs(argv: string[]): ArgMap {
    const result: ArgMap = {};

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (!arg.startsWith('--')) {
            continue;
        }

        const [flag, inlineValue] = arg.split('=', 2);
        const key = flag.slice(2);

        if (!key) {
            continue;
        }

        if (inlineValue !== undefined) {
            result[key] = inlineValue;
            continue;
        }

        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            result[key] = next;
            index += 1;
            continue;
        }

        result[key] = true;
    }

    return result;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    switch (value.toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return undefined;
    }
}

function loadPostgresConfig(): PostgresConnectionOptions {
    const host = process.env.PG_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.PG_PORT ?? '5432', 10);
    const username = process.env.PG_USER ?? '';
    const database = process.env.PG_DATABASE ?? '';
    const ssl = parseOptionalBoolean(process.env.PG_SSL);

    if (!username) {
        throw new Error('PG_USER must be provided.');
    }

    if (!database) {
        throw new Error('PG_DATABASE must be provided.');
    }

    return {
        host,
        port: Number.isNaN(port) ? 5432 : port,
        username,
        password: process.env.PG_PASSWORD,
        database,
        ...(ssl !== undefined ? { ssl } : {}),
    };
}

function resolveSqlitePath(args: ArgMap): string {
    const cliValue = args.sqlite;

    if (typeof cliValue === 'string' && cliValue.length > 0) {
        return cliValue;
    }

    if (typeof process.env.SQLITE_DATABASE === 'string' && process.env.SQLITE_DATABASE.length > 0) {
        return process.env.SQLITE_DATABASE;
    }

    return DEFAULT_SQLITE_PATH;
}

function shouldShowHelp(args: ArgMap): boolean {
    return Boolean(args.help) || Boolean(args.h);
}

function printUsage(): void {
    console.log(`Usage: ts-node scripts/migrate-sqlite-to-pg.ts [options]\n\n` +
        'Options:\n' +
        '  --sqlite <path>        Path to the source SQLite database (default: ./DB/public-pool.sqlite or SQLITE_DATABASE env).\n' +
        '  --batch-size <number>  Number of rows per batch when copying data (default: 500).\n' +
        '  --dry-run              Read from SQLite but skip writes to Postgres.\n' +
        '  --skip-sequence-reset  Migrate data but do not adjust Postgres sequences afterwards.\n' +
        '  --help                 Show this message.\n\n' +
        'Environment variables:\n' +
        '  PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSL (optional).\n');
}

async function runCli(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (shouldShowHelp(args)) {
        printUsage();
        return;
    }

    const dryRun = Boolean(args['dry-run'] ?? args.dryrun);
    const skipSequenceReset = Boolean(args['skip-sequence-reset'] ?? args.skipsequencereset);
    const batchSizeArg = args['batch-size'] ?? args.batchsize;
    const batchSize = normalizeBatchSize(
        typeof batchSizeArg === 'string' ? Number.parseInt(batchSizeArg, 10) : undefined,
    );

    const sqlitePath = resolveSqlitePath(args);

    if (!existsSync(sqlitePath)) {
        throw new Error(`SQLite database not found at path: ${sqlitePath}`);
    }

    const postgresConfig = loadPostgresConfig();

    const sqliteDataSource = new DataSource({
        type: 'sqlite',
        database: sqlitePath,
        entities: [...MIGRATION_ENTITIES],
        logging: false,
    });

    const postgresDataSource = new DataSource({
        type: 'postgres',
        host: postgresConfig.host,
        port: postgresConfig.port,
        username: postgresConfig.username,
        password: postgresConfig.password,
        database: postgresConfig.database,
        ssl: postgresConfig.ssl,
        entities: [...MIGRATION_ENTITIES],
        logging: false,
    });

    try {
        await migrateSqliteToPostgres(sqliteDataSource, postgresDataSource, { batchSize, dryRun, skipSequenceReset });
    } finally {
        if (sqliteDataSource.isInitialized) {
            await sqliteDataSource.destroy();
        }

        if (postgresDataSource.isInitialized) {
            await postgresDataSource.destroy();
        }
    }
}

if (require.main === module) {
    runCli().catch((error) => {
        console.error('Migration failed:', error);
        process.exitCode = 1;
    });
}
