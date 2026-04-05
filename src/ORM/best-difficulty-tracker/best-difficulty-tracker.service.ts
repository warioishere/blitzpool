import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BestDifficultyTrackerEntity } from './best-difficulty-tracker.entity';

@Injectable()
export class BestDifficultyTrackerService {

    constructor(
        @InjectRepository(BestDifficultyTrackerEntity)
        private trackerRepository: Repository<BestDifficultyTrackerEntity>
    ) {}

    /**
     * Get tracker for address
     */
    public async getTracker(address: string): Promise<BestDifficultyTrackerEntity | null> {
        return await this.trackerRepository.findOne({
            where: { address }
        });
    }

    /**
     * Update or create tracker (upsert via INSERT ... ON CONFLICT)
     */
    public async updateTracker(address: string, bestDifficulty: number): Promise<void> {
        const now = Date.now();
        await this.trackerRepository
            .createQueryBuilder()
            .insert()
            .into(BestDifficultyTrackerEntity)
            .values({ address, bestDifficulty, lastCheckedAt: now })
            .orUpdate(['bestDifficulty', 'lastCheckedAt'], ['address'])
            .execute();
    }

    /**
     * Get all trackers (for monitoring)
     */
    public async getAllTrackers(): Promise<BestDifficultyTrackerEntity[]> {
        return await this.trackerRepository.find();
    }

    /**
     * Reset tracker for address
     */
    public async resetTracker(address: string): Promise<void> {
        await this.trackerRepository.update({ address }, {
            bestDifficulty: 0,
            lastCheckedAt: Date.now(),
        });
    }

    /**
     * Delete tracker for address
     */
    public async deleteTracker(address: string): Promise<void> {
        await this.trackerRepository.delete({ address });
    }
}
