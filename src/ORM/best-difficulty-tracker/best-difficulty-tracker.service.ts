import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

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
     * Get trackers for many addresses in one round-trip. Returns a Map for
     * O(1) lookup. Missing addresses are absent from the map (caller uses
     * .has() to distinguish "never seen" from "tracker = 0").
     */
    public async getTrackersForAddresses(addresses: string[]): Promise<Map<string, BestDifficultyTrackerEntity>> {
        const out = new Map<string, BestDifficultyTrackerEntity>();
        if (addresses.length === 0) return out;
        const rows = await this.trackerRepository.find({ where: { address: In(addresses) } });
        for (const row of rows) out.set(row.address, row);
        return out;
    }

    /**
     * Bulk-upsert trackers in one Postgres statement / per-row inserts on
     * sqlite. Replaces a sequential `updateTracker` fan-out in the per-
     * minute checkBestDifficulty cron.
     */
    public async updateTrackersBulk(rows: Array<{ address: string; bestDifficulty: number }>): Promise<void> {
        if (rows.length === 0) return;
        const now = Date.now();
        const dbType = this.trackerRepository.manager.connection.options.type;

        if (dbType === 'postgres') {
            const addresses = rows.map(r => r.address);
            const diffs = rows.map(r => r.bestDifficulty);
            await this.trackerRepository.query(
                `INSERT INTO best_difficulty_tracker_entity (address, "bestDifficulty", "lastCheckedAt", "createdAt", "updatedAt")
                 SELECT address, "bestDifficulty", $3::bigint, NOW(), NOW()
                 FROM unnest($1::text[], $2::double precision[]) AS u(address, "bestDifficulty")
                 ON CONFLICT (address) DO UPDATE SET
                   "bestDifficulty" = EXCLUDED."bestDifficulty",
                   "lastCheckedAt" = EXCLUDED."lastCheckedAt",
                   "updatedAt" = EXCLUDED."updatedAt"`,
                [addresses, diffs, now],
            );
            return;
        }

        // Sqlite (dev/test): keep the existing upsert per row.
        for (const r of rows) {
            await this.trackerRepository
                .createQueryBuilder()
                .insert()
                .into(BestDifficultyTrackerEntity)
                .values({ address: r.address, bestDifficulty: r.bestDifficulty, lastCheckedAt: now })
                .orUpdate(['bestDifficulty', 'lastCheckedAt'], ['address'])
                .execute();
        }
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
