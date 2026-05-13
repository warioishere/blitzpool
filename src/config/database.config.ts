import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { TrackedEntityTimestampSubscriber } from '../ORM/utils/tracked-entity.subscriber';
import { join } from 'path';

type SupportedDriver = 'sqlite' | 'postgres';

const SQLITE_DEFAULT_PATH = './DB/public-pool.sqlite';

function parseOptionalBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    switch (value.trim().toLowerCase()) {
        case 'true':
        case '1':
        case 'yes':
        case 'on':
            return true;
        case 'false':
        case '0':
        case 'no':
        case 'off':
            return false;
        default:
            return undefined;
    }
}

export function isAutoSynchronizeEnabled(config: ConfigService): boolean {
    const flag = parseOptionalBoolean(config.get('DB_AUTO_SYNCHRONIZE'));

    return flag ?? false;
}

function resolveDriver(config: ConfigService): SupportedDriver {
    const driver = config.get<string>('DB_TYPE');

    if (!driver) {
        return 'sqlite';
    }

    switch (driver.toLowerCase()) {
        case 'postgres':
        case 'postgresql':
            return 'postgres';
        case 'sqlite':
            return 'sqlite';
        default:
            return 'sqlite';
    }
}

export function buildDatabaseConfig(config: ConfigService): TypeOrmModuleOptions {
    const driver = resolveDriver(config);
    const logging = config.get('DB_LOGGING');
    const loggingEnabled = parseOptionalBoolean(logging) ?? false;
    const synchronizeOverride = parseOptionalBoolean(config.get('DB_SYNCHRONIZE'));
    const autoSynchronize = isAutoSynchronizeEnabled(config);

    if (driver === 'postgres') {
        const ssl = parseOptionalBoolean(config.get('PG_SSL'));
        const port = Number.parseInt(config.get<string>('PG_PORT', '5432'), 10);

        const runMigrations = parseOptionalBoolean(config.get('DB_RUN_MIGRATIONS'));

        // Connection pooling configuration (Phase 3 optimization)
        const poolSize = Number.parseInt(config.get<string>('PG_POOL_SIZE', '10'), 10);
        const maxQueryExecutionTime = Number.parseInt(config.get<string>('PG_MAX_QUERY_TIME', '30000'), 10);
        const acquireTimeout = Number.parseInt(config.get<string>('PG_ACQUIRE_TIMEOUT', '60000'), 10);
        const idleTimeout = Number.parseInt(config.get<string>('PG_IDLE_TIMEOUT', '10000'), 10);

        const sourceMigrations = join(__dirname, '..', 'migrations', '[0-9]*.{js,ts}');
        const compiledMigrations = join(__dirname, '..', 'src', 'migrations', '[0-9]*.{js,ts}');
        const options: TypeOrmModuleOptions = {
            type: 'postgres',
            host: config.get<string>('PG_HOST', 'localhost'),
            port: Number.isNaN(port) ? 5432 : port,
            username: config.get<string>('PG_USER'),
            password: config.get<string>('PG_PASSWORD'),
            database: config.get<string>('PG_DATABASE'),
            synchronize: synchronizeOverride ?? false,
            autoLoadEntities: true,
            subscribers: [TrackedEntityTimestampSubscriber],
            logging: loggingEnabled,
            migrations: [sourceMigrations, compiledMigrations],
            // Connection pooling (Phase 3)
            poolSize: poolSize,
            maxQueryExecutionTime: maxQueryExecutionTime,
            ...(ssl !== undefined ? { ssl } : {}),
            ...(runMigrations !== undefined ? { migrationsRun: runMigrations } : {}),
        };

        return {
            ...options,
            extra: {
                autoSynchronize,
                // Advanced pg driver pooling options
                max: poolSize, // Maximum pool size
                connectionTimeoutMillis: acquireTimeout, // Connection acquisition timeout
                idleTimeoutMillis: idleTimeout, // Idle connection timeout
                statement_timeout: maxQueryExecutionTime, // Query execution timeout
                query_timeout: maxQueryExecutionTime,
                // Performance optimizations
                application_name: 'blitzpool',
            },
        };
    }

    // SQLite performance configuration (Phase 3 optimization)
    const sqliteBusyTimeout = Number.parseInt(config.get<string>('SQLITE_BUSY_TIMEOUT', '30000'), 10);
    const sqliteCacheSize = Number.parseInt(config.get<string>('SQLITE_CACHE_SIZE', '-64000'), 10); // -64000 = 64MB

    const sqliteOptions: TypeOrmModuleOptions = {
        type: 'sqlite',
        database: config.get<string>('SQLITE_DATABASE', SQLITE_DEFAULT_PATH),
        synchronize: synchronizeOverride ?? true,
        autoLoadEntities: true,
        subscribers: [TrackedEntityTimestampSubscriber],
        logging: loggingEnabled,
        enableWAL: true, // Write-Ahead Logging for better concurrency
        busyTimeout: sqliteBusyTimeout, // Wait up to 30s for locked database
        extra: {
            // SQLite performance pragmas
            synchronous: 'NORMAL', // Balance between safety and speed (WAL mode allows this)
            cache_size: sqliteCacheSize, // Negative = KB, positive = pages (default 64MB)
            temp_store: 'MEMORY', // Store temp tables in memory
            mmap_size: 268435456, // Memory-mapped I/O (256MB)
            page_size: 4096, // Standard page size
            journal_size_limit: 67108864, // 64MB WAL limit
        },
    };

    return sqliteOptions;
}
