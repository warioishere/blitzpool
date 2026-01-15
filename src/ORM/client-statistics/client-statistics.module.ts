import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientStatisticsService } from './client-statistics.service';
import { PoolShareStatisticsEntity } from '../pool-share-statistics/pool-share-statistics.entity';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([ClientStatisticsEntity, PoolShareStatisticsEntity])],
    providers: [ClientStatisticsService],
    exports: [TypeOrmModule, ClientStatisticsService],
})
export class ClientStatisticsModule { }