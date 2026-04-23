import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import type { MiningMode } from '../../services/mining-mode.service';

/**
 * Diff-1 share counts × 2^32 = hash count. Divided by the 10-min bucket
 * (600 s) gives average hashrate in H/s. Same formula as
 * ClientStatisticsService.getChartDataForAddress so curves in /api/info/chart
 * (total) and /api/info/chart/mode/:mode (per-mode) are comparable.
 */
const DIFFICULTY_1_MULTIPLIER = 0xffffffff; // 2^32 - 1, shares-to-hashes
const BUCKET_MS = 10 * 60 * 1000;

@Injectable()
export class PoolModeHashrateService {

    constructor(
        @InjectRepository(PoolModeHashrateEntity)
        private readonly repo: Repository<PoolModeHashrateEntity>,
    ) {}

    /**
     * Add `difficulty` to the current 10-min bucket for `mode`. Upsert-style
     * so parallel shares from different sessions don't create dupe rows.
     * Fire-and-forget; swallow errors so a failed stats write never blocks
     * a share submit.
     */
    async incrementAccepted(mode: MiningMode, difficulty: number): Promise<void> {
        if (!Number.isFinite(difficulty) || difficulty <= 0) return;
        const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
        try {
            await this.repo.query(
                `INSERT INTO pool_mode_hashrate (mode, "time", diff)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (mode, "time")
                 DO UPDATE SET diff = pool_mode_hashrate.diff + EXCLUDED.diff`,
                [mode, bucket, difficulty],
            );
        } catch (err) {
            // Never break share submission on a stats write.
            console.warn(`[PoolModeHashrate] increment failed for ${mode}:`, (err as Error).message);
        }
    }

    /**
     * Chart data for a single mode over the given range, in the same
     * { label, data } shape as /api/info/chart so the UI can treat the
     * series identically.
     */
    async getChart(mode: MiningMode, range: '1d' | '3d' | '7d' = '1d'): Promise<{ label: string; data: number }[]> {
        const now = Date.now();
        const rangeMs =
            range === '7d' ? 7 * 24 * 60 * 60 * 1000
            : range === '3d' ? 3 * 24 * 60 * 60 * 1000
            : 1 * 24 * 60 * 60 * 1000;
        const fromTime = now - rangeMs;

        const rows = await this.repo.find({
            where: { mode, time: Between(fromTime, now) },
            order: { time: 'ASC' },
        });

        return rows.map(r => ({
            label: new Date(r.time).toISOString(),
            data: (r.diff * DIFFICULTY_1_MULTIPLIER) / (BUCKET_MS / 1000),
        }));
    }
}
