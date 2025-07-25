import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';
import { PoolRejectedStatisticsService } from './pool-rejected-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PoolRejectedStatisticsEntity]), ScheduleModule],
  providers: [PoolRejectedStatisticsService],
  exports: [TypeOrmModule, ScheduleModule, PoolRejectedStatisticsService],
})
export class PoolRejectedStatisticsModule {}
