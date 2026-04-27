import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';

import { buildDatabaseConfig } from './src/config/database.config';
import { AddressSettingsEntity } from './src/ORM/address-settings/address-settings.entity';
import { BestDifficultyTrackerEntity } from './src/ORM/best-difficulty-tracker/best-difficulty-tracker.entity';
import { BlocksEntity } from './src/ORM/blocks/blocks.entity';
import { ClientEntity } from './src/ORM/client/client.entity';
import { ClientDifficultyStatisticsEntity } from './src/ORM/client-difficulty-statistics/client-difficulty-statistics.entity';
import { ClientRejectedStatisticsEntity } from './src/ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from './src/ORM/client-statistics/client-statistics.entity';
import { ExternalSharesEntity } from './src/ORM/external-shares/external-shares.entity';
import { NetworkDifficultyTrackerEntity } from './src/ORM/network-difficulty-tracker/network-difficulty-tracker.entity';
import { NtfySubscriptionsEntity } from './src/ORM/ntfy-subscriptions/ntfy-subscriptions.entity';
import { PoolRejectedStatisticsEntity } from './src/ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from './src/ORM/pool-share-statistics/pool-share-statistics.entity';
import { PushSubscriptionEntity } from './src/ORM/push-subscriptions/push-subscription.entity';
import { RpcBlockEntity } from './src/ORM/rpc-block/rpc-block.entity';
import { TelegramSubscriptionsEntity } from './src/ORM/telegram-subscriptions/telegram-subscriptions.entity';
import { PplnsBalanceEntity } from './src/ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from './src/ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsGroupEntity } from './src/ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from './src/ORM/pplns-group/pplns-group-member.entity';
import { PplnsGroupBlockHistoryEntity } from './src/ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from './src/ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupInvitationEntity } from './src/ORM/pplns-group/pplns-group-invitation.entity';
import { AddressEmailEntity } from './src/ORM/address-email/address-email.entity';
import { EmailVerificationEntity } from './src/ORM/address-email/email-verification.entity';
import { PoolModeHashrateEntity } from './src/ORM/pool-mode-hashrate/pool-mode-hashrate.entity';
import { WorkerSharesEntity } from './src/ORM/worker-shares/worker-shares.entity';

loadEnv({ path: process.env.TYPEORM_ENV_PATH ?? '.env' });

const configService = new ConfigService(process.env);
const moduleOptions = buildDatabaseConfig(configService);

const entities = [
    AddressSettingsEntity,
    BestDifficultyTrackerEntity,
    BlocksEntity,
    ClientEntity,
    ClientDifficultyStatisticsEntity,
    ClientRejectedStatisticsEntity,
    ClientStatisticsEntity,
    ExternalSharesEntity,
    NetworkDifficultyTrackerEntity,
    NtfySubscriptionsEntity,
    PoolRejectedStatisticsEntity,
    PoolShareStatisticsEntity,
    PushSubscriptionEntity,
    RpcBlockEntity,
    TelegramSubscriptionsEntity,
    PplnsBalanceEntity,
    PplnsPayoutHistoryEntity,
    PplnsGroupEntity,
    PplnsGroupMemberEntity,
    PplnsGroupBlockHistoryEntity,
    PplnsGroupBalanceEntity,
    PplnsGroupInvitationEntity,
    AddressEmailEntity,
    EmailVerificationEntity,
    PoolModeHashrateEntity,
    WorkerSharesEntity,
];

const { autoLoadEntities, ...rest } = moduleOptions as DataSourceOptions & { autoLoadEntities?: boolean };

const sourceMigrations = join(__dirname, 'src', 'migrations', '[0-9]*.{ts,js}');
const compiledMigrations = join(__dirname, 'dist', 'src', 'migrations', '[0-9]*.{ts,js}');

const options: DataSourceOptions = {
    ...rest,
    entities,
    migrations: [sourceMigrations, compiledMigrations],
};

let dataSource: DataSource;

if (options.type === 'postgres' && process.env.TYPEORM_USE_PGMEM === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { newDb } = require('pg-mem');
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
        name: 'current_database',
        implementation: () => 'pg_mem',
    });
    db.public.registerFunction({
        name: 'version',
        implementation: () => 'pg-mem',
    });
    dataSource = db.adapters.createTypeormDataSource({
        ...options,
        type: 'postgres',
        database: 'pg-mem',
    });
} else {
    dataSource = new DataSource(options);
}

export default dataSource;
