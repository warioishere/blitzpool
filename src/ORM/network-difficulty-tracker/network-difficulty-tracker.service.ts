import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NetworkDifficultyTrackerEntity } from './network-difficulty-tracker.entity';

@Injectable()
export class NetworkDifficultyTrackerService {

    constructor(
        @InjectRepository(NetworkDifficultyTrackerEntity)
        private trackerRepository: Repository<NetworkDifficultyTrackerEntity>
    ) {}

    /**
     * Get the singleton tracker record
     */
    public async getTracker(): Promise<NetworkDifficultyTrackerEntity | null> {
        return await this.trackerRepository.findOne({
            where: { id: 1 }
        });
    }

    /**
     * Update or create tracker (upsert)
     * @param currentDifficulty - The current network difficulty
     * @param difficultyChanged - Whether the difficulty has changed from the previous check
     */
    public async updateTracker(
        currentDifficulty: number,
        difficultyChanged: boolean = false
    ): Promise<void> {
        const existing = await this.trackerRepository.findOne({
            where: { id: 1 }
        });

        const now = Date.now();

        if (existing) {
            if (difficultyChanged) {
                existing.previousDifficulty = existing.currentDifficulty;
                existing.currentDifficulty = currentDifficulty;
                existing.lastChangedAt = now;
            }
            existing.lastCheckedAt = now;
            await this.trackerRepository.save(existing);
        } else {
            // First initialization
            const newTracker = this.trackerRepository.create({
                id: 1,
                currentDifficulty,
                previousDifficulty: null,
                lastCheckedAt: now,
                lastChangedAt: null
            });
            await this.trackerRepository.save(newTracker);
        }
    }
}
