import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { redisStore } from 'cache-manager-redis-yet';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { NtfySubscriptionsModule } from './ORM/ntfy-subscriptions/ntfy-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';
import { NtfyService } from './services/ntfy.service';
import { ExternalSharesService } from './services/external-shares.service';
import { GeoIpService } from './services/geoip.service';
import { ShareTotalsCacheService } from './services/share-totals-cache.service';
import { AddressSettingsCacheService } from './services/address-settings-cache.service';
import { StatisticsBatchService } from './services/statistics-batch.service';
import { AggregationService } from './services/aggregation.service';
import { MetricsService } from './services/metrics.service';
import { WorkerPoolService } from './services/worker-pool.service';
import { ExternalShareController } from './controllers/external-share/external-share.controller';
import { ExternalSharesModule } from './ORM/external-shares/external-shares.module';
import { PoolShareStatisticsModule } from './ORM/pool-share-statistics/pool-share-statistics.module';
import { PoolRejectedStatisticsModule } from './ORM/pool-rejected-statistics/pool-rejected-statistics.module';
import { ClientRejectedStatisticsModule } from './ORM/client-rejected-statistics/client-rejected-statistics.module';
import { ClientDifficultyStatisticsModule } from './ORM/client-difficulty-statistics/client-difficulty-statistics.module';
import { buildDatabaseConfig } from './config/database.config';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    TelegramSubscriptionsModule,
    NtfySubscriptionsModule,
    BlocksModule,
    RpcBlocksModule,
    ExternalSharesModule,
    PoolShareStatisticsModule,
    PoolRejectedStatisticsModule,
    ClientRejectedStatisticsModule,
    ClientDifficultyStatisticsModule,
]

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => buildDatabaseConfig(configService),
        }),
        CacheModule.registerAsync({
            isGlobal: true,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => {
                const redisHost = configService.get<string>('REDIS_HOST');
                const redisPort = parseInt(configService.get<string>('REDIS_PORT') ?? '6379', 10);
                const redisPassword = configService.get<string>('REDIS_PASSWORD');
                const redisDb = parseInt(configService.get<string>('REDIS_DB') ?? '0', 10);
                const redisTtl = parseInt(configService.get<string>('REDIS_TTL') ?? '600', 10);

                // Use Redis if REDIS_HOST is configured, otherwise fall back to in-memory cache
                if (redisHost && redisHost.length > 0) {
                    console.log(`[Cache] Using Redis cache at ${redisHost}:${redisPort} (DB: ${redisDb})`);
                    try {
                        return {
                            store: await redisStore({
                                socket: {
                                    host: redisHost,
                                    port: redisPort,
                                },
                                password: redisPassword && redisPassword.length > 0 ? redisPassword : undefined,
                                database: redisDb,
                                ttl: redisTtl * 1000, // Convert to milliseconds
                            }),
                        };
                    } catch (error) {
                        console.error('[Cache] Failed to connect to Redis, falling back to in-memory cache:', error);
                        return {}; // Fall back to in-memory cache
                    }
                } else {
                    console.log('[Cache] Using in-memory cache (Redis not configured)');
                    return {}; // In-memory cache
                }
            },
        }),
        ScheduleModule.forRoot(),
        HttpModule,
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController,
        ExternalShareController
    ],
    providers: [
        DiscordService,
        AppService,
        StratumV1Service,
        TelegramService,
        NtfyService,
        BitcoinRpcService,
        NotificationService,
        BitcoinAddressValidator,
        StratumV1JobsService,
        BTCPayService,
        BraiinsService,
        ExternalSharesService,
        GeoIpService,
        ShareTotalsCacheService,
        AddressSettingsCacheService,
        StatisticsBatchService,
        AggregationService,
        MetricsService,
        WorkerPoolService,
    ],
})
export class AppModule {
    constructor() {

    }
}
