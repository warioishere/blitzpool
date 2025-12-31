import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NetworkDifficultyTrackerEntity } from './network-difficulty-tracker.entity';
import { NetworkDifficultyTrackerService } from './network-difficulty-tracker.service';

@Module({
    imports: [TypeOrmModule.forFeature([NetworkDifficultyTrackerEntity])],
    providers: [NetworkDifficultyTrackerService],
    exports: [NetworkDifficultyTrackerService],
})
export class NetworkDifficultyTrackerModule {}
