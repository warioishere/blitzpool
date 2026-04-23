import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import type { MiningMode } from '../../services/mining-mode.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { DIFFICULTY_1, SLOT_DURATION_MS } from '../../constants/mining.constants';

/**
 * Per-mode pool-wide hashrate stats, keyed on the same 10-min end-time slots
 * as `client_statistics` (see TimeSlotHelper). Written once per accepted share
 * after the stratum layer's routing decision; queried by /api/info/chart/mode
 * and /api/pplns/chart. Same slot convention + same hashrate formula as
 * ClientStatisticsService so splash curves align to one x-axis.
 */
@Injectable()
export class PoolModeHashrateService {

    constructor(
        @InjectRepository(PoolModeHashrateEntity)
        private readonly repo: Repository<PoolModeHashrateEntity>,
    ) {}

    /**
     * Add `difficulty` to the current end-time slot for `mode`. UPSERT-style
     * so parallel shares don't create dupe rows. Fire-and-forget; swallow
     * errors so a failed stats write never blocks a share submit.
     */
    async incrementAccepted(mode: MiningMode, difficulty: number): Promise<void> {
        if (!Number.isFinite(difficulty) || difficulty <= 0) return;
        const slot = TimeSlotHelper.getCurrentSlot();
        try {
            await this.repo.query(
                `INSERT INTO pool_mode_hashrate (mode, "time", diff)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (mode, "time")
                 DO UPDATE SET diff = pool_mode_hashrate.diff + EXCLUDED.diff`,
                [mode, slot, difficulty],
            );
        } catch (err) {
            console.warn(`[PoolModeHashrate] increment failed for ${mode}:`, (err as Error).message);
        }
    }

    /**
     * Chart data for a single mode over the given range in the shape
     * [{ label, data }]. Mirrors ClientStatisticsService.getChartDataForSite
     * exactly: end-time-labeled 10-min slots, current incomplete slot
     * excluded, hashrate = shares × DIFFICULTY_1 / 600s. Reading the same
     * way it's read elsewhere means splash sees new data points on all
     * curves at the same moment instead of one jumping ahead.
     */
    async getChart(mode: MiningMode, range: '1d' | '3d' | '7d' = '1d'): Promise<{ label: string; data: number }[]> {
        const diffDays = range === '7d' ? 7 : range === '3d' ? 3 : 1;
        const currentSlot = TimeSlotHelper.getCurrentSlot();
        const since = Date.now() - diffDays * 24 * 60 * 60 * 1000;
        const limit = diffDays * 144;

        const result = await this.repo
            .createQueryBuilder('entry')
            .select('entry.time', 'label')
            .addSelect(`ROUND((entry.diff * ${DIFFICULTY_1}) / 600)`, 'data')
            .where('entry.mode = :mode', { mode })
            .andWhere('entry.time >= :since', { since })
            .andWhere('entry.time < :currentSlot', { currentSlot })
            .orderBy('entry.time', 'ASC')
            .limit(limit)
            .getRawMany();

        return result.map((res) => ({
            label: new Date(Number(res.label)).toISOString(),
            data: res.data == null ? 0 : Number(res.data),
        }));
    }
}

// Re-export slot duration for callers that want to reason about
// cadence (e.g. chart consumers). Re-export rather than redefine so
// there's one source of truth — the mining.constants file.
export { SLOT_DURATION_MS };
