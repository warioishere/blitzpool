import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import {
    DEFAULT_SQLITE_PATH,
    MigrationLogger,
    runAutomaticSqliteToPostgresMigration,
} from '../migration/sqlite-to-postgres';

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
    if (value === undefined) {
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

class NestMigrationLogger implements MigrationLogger {
    constructor(private readonly logger: Logger) {}

    info(message: string): void {
        this.logger.log(message);
    }

    warn(message: string): void {
        this.logger.warn(message);
    }

    error(message: string, error?: unknown): void {
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(message, stack);
    }
}

@Injectable()
export class AppService implements OnModuleInit {

    private readonly logger = new Logger(AppService.name);

    private readonly migrationLogger = new NestMigrationLogger(this.logger);

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
        private readonly clientService: ClientService,
        private readonly dataSource: DataSource,
        private readonly rpcBlockService: RpcBlockService,
    ) {

    }

    async onModuleInit() {
        // if (process.env.NODE_APP_INSTANCE == '0') {
        //     await this.dataSource.query(`VACUUM;`);
        // }

        //https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
        // //500 MB DB cache
        // await this.dataSource.query(`PRAGMA cache_size = -500000;`);
        //Normal is still completely corruption safe in WAL mode, and means only WAL checkpoints have to wait for FSYNC.
        const dataSourceType = (this.dataSource.options as { type?: string } | undefined)?.type;
        if (dataSourceType === 'sqlite') {
            await this.dataSource.query('PRAGMA synchronous = off;');
        }

        await this.runAutomaticSqliteMigrationIfNeeded();

        // //6Gb
        // await this.dataSource.query(`PRAGMA mmap_size = 6000000000;`);

        if (process.env.NODE_APP_INSTANCE === undefined) {
            await this.clientService.deleteAll();
        }

        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {

            setInterval(async () => {
                await this.deleteOldStatistics();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Killing dead clients');
                await this.clientService.killDeadClients();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);



        }

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        await this.clientStatisticsService.deleteOldStatistics();
        const cutoff = Math.floor(
            (Date.now() - 30 * 24 * 60 * 60 * 1000) / (60 * 60 * 1000),
        ) * (60 * 60 * 1000);
        await this.clientDifficultyStatisticsService.deleteOlderThan(cutoff);
        console.log('Deleted old statistics');
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


    private async runAutomaticSqliteMigrationIfNeeded(): Promise<void> {
        const nodeInstance = process.env.NODE_APP_INSTANCE;
        if (nodeInstance !== undefined && nodeInstance !== '0') {
            return;
        }

        const dataSourceType = (this.dataSource.options as { type?: string } | undefined)?.type;
        if (dataSourceType !== 'postgres') {
            return;
        }

        const runMigrations = parseOptionalBoolean(process.env.DB_RUN_MIGRATIONS);
        if (runMigrations === false) {
            this.logger.log('DB_RUN_MIGRATIONS is disabled; skipping automatic SQLite data migration.');
            return;
        }

        if (runMigrations !== true) {
            // Preserve legacy behaviour: only trigger automatic migrations when the flag is explicitly enabled.
            return;
        }

        const migrateData = parseOptionalBoolean(process.env.DB_MIGRATE_SQLITE_ON_BOOT);
        if (migrateData === false) {
            this.logger.log('DB_MIGRATE_SQLITE_ON_BOOT is disabled; skipping automatic SQLite data migration.');
            return;
        }

        const sqlitePath = process.env.SQLITE_DATABASE ?? DEFAULT_SQLITE_PATH;

        const summary = await runAutomaticSqliteToPostgresMigration(this.dataSource, {
            sqlitePath,
            logger: this.migrationLogger,
        });

        if (!summary.didRun) {
            if (summary.skipReason === 'sqlite-not-found') {
                this.logger.log(`SQLite database not found at ${summary.sqlitePath}; skipping automatic data migration.`);
            } else if (summary.skipReason === 'target-not-empty') {
                this.logger.log('Postgres already contains data; skipping automatic SQLite data migration.');
            }
            return;
        }

        this.logger.log(`Migrated ${summary.migratedRows} rows from SQLite (${summary.sqlitePath}) to Postgres.`);
    }
}
