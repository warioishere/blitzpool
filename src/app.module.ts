import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

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
        CacheModule.register(),
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
    ],
})
export class AppModule {
    constructor() {

    }
}
