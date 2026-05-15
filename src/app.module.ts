import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { redisStore } from 'cache-manager-redis-yet';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { InfoController } from './controllers/info/info.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { WorkerSharesModule } from './ORM/worker-shares/worker-shares.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { PoolModeHashrateModule } from './ORM/pool-mode-hashrate/pool-mode-hashrate.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { NtfySubscriptionsModule } from './ORM/ntfy-subscriptions/ntfy-subscriptions.module';
import { PushSubscriptionModule } from './ORM/push-subscriptions/push-subscription.module';
import { BestDifficultyTrackerModule } from './ORM/best-difficulty-tracker/best-difficulty-tracker.module';
import { NetworkDifficultyTrackerModule } from './ORM/network-difficulty-tracker/network-difficulty-tracker.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BTCPayService } from './services/btc-pay.service';
import { NotificationService } from './services/notification.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { ProtocolDetectorService } from './services/protocol-detector.service';
import { StratumV2Service } from './services/stratum-v2.service';
import { TelegramService } from './services/telegram.service';
import { NtfyService } from './services/ntfy.service';
import { ExternalSharesService } from './services/external-shares.service';
import { GeoIpService } from './services/geoip.service';
import { ShareTotalsCacheService } from './services/share-totals-cache.service';
import { AddressSettingsCacheService } from './services/address-settings-cache.service';
import { StatisticsCoordinatorService } from './services/statistics-coordinator.service';
import { AggregationService } from './services/aggregation.service';
import { MetricsService } from './services/metrics.service';
import { WorkerPoolService } from './services/worker-pool.service';
import { TimeslotMigrationService } from './services/timeslot-migration.service';
import { DifficultyScoresCacheService } from './services/difficulty-scores-cache.service';
import { PushNotificationService } from './services/push-notification.service';
import { FcmService } from './services/fcm.service';
import { TemplateDistributionService } from './services/template-distribution.service';
import { DownstreamReportService } from './services/downstream-report.service';
import { JobDeclarationService } from './services/job-declaration.service';
import { PplnsService } from './services/pplns.service';
import { PplnsBalanceService } from './ORM/pplns-balance/pplns-balance.service';
import { PplnsBalanceEntity } from './ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from './ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsController } from './controllers/pplns/pplns.controller';
import { GroupSoloService } from './services/group-solo.service';
import { GroupService } from './services/group.service';
import { GroupRoundResetService } from './services/group-round-reset.service';
import { EmailService } from './services/email.service';
import { AddressEmailService } from './services/address-email.service';
import { CoinbaseCapacityMonitorService } from './services/coinbase-capacity-monitor.service';
import { PplnsGroupInvitationService } from './services/pplns-group-invitation.service';
import { PplnsGroupJoinRequestService } from './services/pplns-group-join-request.service';
import { MiningModeService } from './services/mining-mode.service';
import { MinerActiveModeService } from './services/miner-active-mode.service';
import { DustSweepService } from './services/dust-sweep.service';
import { PplnsGroupEntity } from './ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from './ORM/pplns-group/pplns-group-member.entity';
import { PplnsGroupBlockHistoryEntity } from './ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from './ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupInvitationEntity } from './ORM/pplns-group/pplns-group-invitation.entity';
import { PplnsGroupJoinRequestEntity } from './ORM/pplns-group/pplns-group-join-request.entity';
import { AddressEmailEntity } from './ORM/address-email/address-email.entity';
import { EmailVerificationEntity } from './ORM/address-email/email-verification.entity';
import { PplnsGroupController } from './controllers/pplns-group/pplns-group.controller';
import { PplnsInvitationController } from './controllers/pplns-invitation/pplns-invitation.controller';
import { EmailController } from './controllers/email/email.controller';
import { DownstreamReportController } from './controllers/downstream-report/downstream-report.controller';
import { ExternalShareController } from './controllers/external-share/external-share.controller';
import { PushController } from './controllers/push/push.controller';
import { ExternalSharesModule } from './ORM/external-shares/external-shares.module';
import { PoolShareStatisticsModule } from './ORM/pool-share-statistics/pool-share-statistics.module';
import { PoolRejectedStatisticsModule } from './ORM/pool-rejected-statistics/pool-rejected-statistics.module';
import { ClientRejectedStatisticsModule } from './ORM/client-rejected-statistics/client-rejected-statistics.module';
import { ClientDifficultyStatisticsModule } from './ORM/client-difficulty-statistics/client-difficulty-statistics.module';
import { buildDatabaseConfig } from './config/database.config';

const ORMModules = [
    ClientStatisticsModule,
    PoolModeHashrateModule,
    ClientModule,
    AddressSettingsModule,
    WorkerSharesModule,
    TelegramSubscriptionsModule,
    NtfySubscriptionsModule,
    PushSubscriptionModule,
    BestDifficultyTrackerModule,
    NetworkDifficultyTrackerModule,
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
        // ThrottlerModule loaded only so per-endpoint @UseGuards(ThrottlerGuard)
        // + @Throttle(...) on a handful of abuse-prone POSTs (email register,
        // group create / invitation, invitation accept / decline) can resolve
        // their backend. Defaults are intentionally unused — there is no
        // global guard, and untagged endpoints are not rate-limited.
        ThrottlerModule.forRoot({ ttl: 60, limit: 60 }),
        HttpModule,
        TypeOrmModule.forFeature([
            PplnsBalanceEntity,
            PplnsPayoutHistoryEntity,
            PplnsGroupEntity,
            PplnsGroupMemberEntity,
            PplnsGroupBlockHistoryEntity,
            PplnsGroupBalanceEntity,
            PplnsGroupInvitationEntity,
            PplnsGroupJoinRequestEntity,
            AddressEmailEntity,
            EmailVerificationEntity,
        ]),
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController,
        DownstreamReportController,
        ExternalShareController,
        PushController,
        InfoController,
        PplnsController,
        PplnsGroupController,
        PplnsInvitationController,
        EmailController,
    ],
    providers: [
        // TimeslotMigrationService, // Disabled - migration incomplete, leaving data in mixed state
        AppService,
        StratumV1Service,
        TelegramService,
        NtfyService,
        FcmService,
        PushNotificationService,
        BitcoinRpcService,
        NotificationService,
        BitcoinAddressValidator,
        StratumV1JobsService,
        BTCPayService,
        ExternalSharesService,
        GeoIpService,
        ShareTotalsCacheService,
        AddressSettingsCacheService,
        StatisticsCoordinatorService, // Simplified statistics coordination (instance 0 only)
        AggregationService,
        MetricsService,
        WorkerPoolService,
        DifficultyScoresCacheService,
        DownstreamReportService,
        ProtocolDetectorService,
        TemplateDistributionService,
        StratumV2Service,
        JobDeclarationService,
        PplnsService,
        PplnsBalanceService,
        GroupSoloService,
        GroupService,
        GroupRoundResetService,
        MiningModeService,
        MinerActiveModeService,
        DustSweepService,
        EmailService,
        AddressEmailService,
        PplnsGroupInvitationService,
        PplnsGroupJoinRequestService,
        CoinbaseCapacityMonitorService,
    ],
})
export class AppModule {
    constructor() {

    }
}
