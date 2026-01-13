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
     * Update or create tracker (upsert)
     */
    public async updateTracker(address: string, bestDifficulty: number): Promise<void> {
        const existing = await this.trackerRepository.findOne({
            where: { address }
        });

        if (existing) {
            existing.bestDifficulty = bestDifficulty;
            existing.lastCheckedAt = Date.now();
            await this.trackerRepository.save(existing);
        } else {
            const newTracker = this.trackerRepository.create({
                address,
                bestDifficulty,
                lastCheckedAt: Date.now()
            });
            await this.trackerRepository.save(newTracker);
        }
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
        const existing = await this.trackerRepository.findOne({
            where: { address }
        });

        if (existing) {
            existing.bestDifficulty = 0;
            existing.lastCheckedAt = Date.now();
            await this.trackerRepository.save(existing);
        }
    }

    /**
     * Delete tracker for address
     */
    public async deleteTracker(address: string): Promise<void> {
        await this.trackerRepository.delete({ address });
    }
}
