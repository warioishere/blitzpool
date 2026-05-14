import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { PoolModeHashrateService } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import {
    DEFAULT_SQLITE_PATH,
    MigrationLogger,
    runAutomaticSqliteToPostgresMigration,
} from '../migration/sqlite-to-postgres';
import { isAutoSynchronizeEnabled } from '../config/database.config';

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

    private readonly autoSynchronize: boolean;

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly clientService: ClientService,
        private readonly poolModeHashrateService: PoolModeHashrateService,
        private readonly dataSource: DataSource,
        private readonly rpcBlockService: RpcBlockService,
        configService: ConfigService,
    ) {

        this.autoSynchronize = isAutoSynchronizeEnabled(configService);
    }

    async onModuleInit() {
        //Normal is still completely corruption safe in WAL mode, and means only WAL checkpoints have to wait for FSYNC.
        const dataSourceType = (this.dataSource.options as { type?: string } | undefined)?.type;
        if (dataSourceType === 'sqlite') {
            await this.dataSource.query('PRAGMA synchronous = off;');
        }

        await this.runAutomaticSqliteMigrationIfNeeded();

        if (dataSourceType === 'postgres' && this.autoSynchronize) {
            await this.dataSource.synchronize();
        }

        await this.clientService.deleteAll();

        // Clean up stale sessions immediately on startup
        console.log('Startup: killing dead clients');
        await this.clientService.killDeadClients();

        setInterval(async () => {
            await this.deleteOldStatistics();
        }, 1000 * 60 * 60);

        setInterval(async () => {
            console.log('Killing dead clients');
            await this.clientService.killDeadClients();
        }, 1000 * 60 * 2);

        setInterval(async () => {
            console.log('Deleting Old Blocks');
            await this.rpcBlockService.deleteOldBlocks();
        }, 1000 * 60 * 60 * 24);

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        // 14-day cutoff for per-(address, worker, session, slot) detail
        // tables — the UI only renders 1d/3d/7d charts from these. Lifetime
        // totals + balances live in worker_shares_entity /
        // address_settings_entity / pplns_balance and are untouched.
        //
        // Intentionally NOT cleaned: pool_share_statistics_entity +
        // pool_rejected_statistics_entity. /api/info/shares serves 30-day
        // totals plus an "accepted-since-last-block" counter (resets when
        // the pool finds a block); both span longer than 14d at a small
        // pool where blocks are infrequent. The two pool-wide tables are
        // tiny (~150k rows total at prod scale) — keeping them uncleaned
        // costs negligible storage and avoids breaking those endpoints.
        const cutoff14d = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const cutoffHourly = Math.floor(cutoff14d / (60 * 60 * 1000)) * (60 * 60 * 1000);

        await this.clientStatisticsService.deleteOldStatistics();
        await this.clientDifficultyStatisticsService.deleteOlderThan(cutoffHourly);
        await this.clientRejectedStatisticsService.deleteOlderThan(cutoff14d);
        await this.poolModeHashrateService.deleteOlderThan(cutoff14d);

        console.log('Deleted old statistics');
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


    private async flushRedisBeforeMigration(): Promise<void> {
        try {
            const store: any = this.cacheManager.store;
            if (store?.client) {
                this.logger.log('Flushing Redis database before SQLite→PostgreSQL migration...');
                await store.client.flushDb();
                this.logger.log('Redis FLUSHDB complete.');
            } else {
                this.logger.warn('Redis client not available — skipping FLUSHDB before migration.');
            }
        } catch (error) {
            this.logger.error('Failed to flush Redis before migration', error instanceof Error ? error.stack : undefined);
            throw error;
        }
    }

    private async runAutomaticSqliteMigrationIfNeeded(): Promise<void> {
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
            beforeMigration: () => this.flushRedisBeforeMigration(),
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
