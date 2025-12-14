import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BestDifficultyTrackerEntity } from './best-difficulty-tracker.entity';
import { BestDifficultyTrackerService } from './best-difficulty-tracker.service';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([BestDifficultyTrackerEntity])],
    providers: [BestDifficultyTrackerService],
    exports: [TypeOrmModule, BestDifficultyTrackerService],
})
export class BestDifficultyTrackerModule { }
