import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';
import { PoolShareStatisticsService } from './pool-share-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PoolShareStatisticsEntity])],
  providers: [PoolShareStatisticsService],
  exports: [TypeOrmModule, PoolShareStatisticsService],
})
export class PoolShareStatisticsModule {}
