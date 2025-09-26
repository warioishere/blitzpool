import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
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

    if (driver === 'postgres') {
        const ssl = parseOptionalBoolean(config.get('PG_SSL'));
        const port = Number.parseInt(config.get<string>('PG_PORT', '5432'), 10);

        const runMigrations = parseOptionalBoolean(config.get('DB_RUN_MIGRATIONS'));

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
            logging: loggingEnabled,
            migrations: [sourceMigrations, compiledMigrations],
            ...(ssl !== undefined ? { ssl } : {}),
            ...(runMigrations !== undefined ? { migrationsRun: runMigrations } : {}),
        };

        return options;
    }

    const sqliteOptions: TypeOrmModuleOptions = {
        type: 'sqlite',
        database: config.get<string>('SQLITE_DATABASE', SQLITE_DEFAULT_PATH),
        synchronize: synchronizeOverride ?? true,
        autoLoadEntities: true,
        logging: loggingEnabled,
        enableWAL: true,
        busyTimeout: 30 * 1000,
    };

    return sqliteOptions;
}
