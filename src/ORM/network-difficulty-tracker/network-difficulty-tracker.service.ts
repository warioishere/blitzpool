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
     * Update or create tracker (upsert via INSERT ... ON CONFLICT)
     * @param currentDifficulty - The current network difficulty
     * @param difficultyChanged - Whether the difficulty has changed from the previous check
     */
    public async updateTracker(
        currentDifficulty: number,
        difficultyChanged: boolean = false
    ): Promise<void> {
        const now = Date.now();

        if (difficultyChanged) {
            // When difficulty changed: shift current→previous, update all fields
            // Use raw query to reference the existing row's currentDifficulty
            await this.trackerRepository.query(
                `INSERT INTO network_difficulty_tracker_entity ("id", "currentDifficulty", "previousDifficulty", "lastCheckedAt", "lastChangedAt", "createdAt", "updatedAt")
                 VALUES (1, $1, NULL, $2, $2, $2, $2)
                 ON CONFLICT ("id") DO UPDATE SET
                   "previousDifficulty" = network_difficulty_tracker_entity."currentDifficulty",
                   "currentDifficulty" = $1,
                   "lastCheckedAt" = $2,
                   "lastChangedAt" = $2,
                   "updatedAt" = $2`,
                [currentDifficulty, now],
            );
        } else {
            // No change: just update lastCheckedAt, insert if first run.
            // createdAt/updatedAt set explicitly — createQueryBuilder().insert()
            // bypasses the @BeforeInsert hook on TrackedEntity.
            await this.trackerRepository
                .createQueryBuilder()
                .insert()
                .into(NetworkDifficultyTrackerEntity)
                .values({
                    id: 1,
                    currentDifficulty,
                    previousDifficulty: null,
                    lastCheckedAt: now,
                    lastChangedAt: null,
                    createdAt: now,
                    updatedAt: now,
                })
                .orUpdate(['lastCheckedAt'], ['id'])
                .execute();
        }
    }
}
