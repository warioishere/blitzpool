import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';
import { ClientRejectedStatisticsService } from './client-rejected-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ClientRejectedStatisticsEntity])],
  providers: [ClientRejectedStatisticsService],
  exports: [TypeOrmModule, ClientRejectedStatisticsService],
})
export class ClientRejectedStatisticsModule {}
