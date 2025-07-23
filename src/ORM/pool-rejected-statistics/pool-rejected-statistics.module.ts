import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';
import { PoolRejectedStatisticsService } from './pool-rejected-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PoolRejectedStatisticsEntity])],
  providers: [PoolRejectedStatisticsService],
  exports: [TypeOrmModule, PoolRejectedStatisticsService],
})
export class PoolRejectedStatisticsModule {}
