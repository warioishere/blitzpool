import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';
import { ClientRejectedStatisticsService } from './client-rejected-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ClientRejectedStatisticsEntity]), ScheduleModule],
  providers: [ClientRejectedStatisticsService],
  exports: [TypeOrmModule, ScheduleModule, ClientRejectedStatisticsService],
})
export class ClientRejectedStatisticsModule {}
