import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientDifficultyStatisticsEntity } from './client-difficulty-statistics.entity';
import { ClientDifficultyStatisticsService } from './client-difficulty-statistics.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ClientDifficultyStatisticsEntity])],
  providers: [ClientDifficultyStatisticsService],
  exports: [TypeOrmModule, ClientDifficultyStatisticsService],
})
export class ClientDifficultyStatisticsModule {}
