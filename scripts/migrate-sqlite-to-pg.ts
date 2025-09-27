import 'reflect-metadata';

import { existsSync } from 'fs';
import { DataSource } from 'typeorm';

import {
    DEFAULT_SQLITE_PATH,
    MIGRATION_ENTITIES,
    migrateSqliteToPostgres,
} from '../src/migration/sqlite-to-postgres';

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
        '  --skip-if-target-has-data  Skip migrating when the Postgres database already contains rows.\n' +
        '  --help                 Show this message.\n\n' +
        'Environment variables:\n' +
        '  PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSL (optional).\n');
}

export async function runMigrationCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    const args = parseArgs(argv);

    if (shouldShowHelp(args)) {
        printUsage();
        return;
    }

    const dryRun = Boolean(args['dry-run'] ?? args.dryrun);
    const skipSequenceReset = Boolean(args['skip-sequence-reset'] ?? args.skipsequencereset);
    const batchSizeArg = args['batch-size'] ?? args.batchsize;
    const batchSize = typeof batchSizeArg === 'string' ? Number.parseInt(batchSizeArg, 10) : undefined;
    const skipIfTargetHasData = Boolean(
        args['skip-if-target-has-data'] ?? args.skipiftargethasdata,
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
        const summary = await migrateSqliteToPostgres(
            sqliteDataSource,
            postgresDataSource,
            { batchSize, dryRun, skipSequenceReset, skipIfTargetHasData },
        );

        if (!summary.didRun && summary.skipReason === 'target-not-empty') {
            console.log('Skipped migration because the Postgres database already contains data.');
        }
        console.log(`Processed ${summary.migratedRows} rows${dryRun ? ' (dry-run)' : ''}.`);
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
    runMigrationCli().catch((error) => {
        console.error('Migration failed:', error);
        process.exitCode = 1;
    });
}
