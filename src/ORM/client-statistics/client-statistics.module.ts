import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientStatisticsService } from './client-statistics.service';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([ClientStatisticsEntity]), ConfigModule],
    providers: [ClientStatisticsService],
    exports: [TypeOrmModule, ClientStatisticsService],
})
export class ClientStatisticsModule { }
