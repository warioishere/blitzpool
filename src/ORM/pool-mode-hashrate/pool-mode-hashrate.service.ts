import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import type { MiningMode } from '../../services/mining-mode.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import {
    DIFFICULTY_1,
    MAX_REASONABLE_DIFFICULTY,
    SLOT_DURATION_MS,
} from '../../constants/mining.constants';
import { NestedDeltaBuffer } from '../../utils/buffers';

/**
 * Per-mode pool-wide hashrate stats, keyed on 10-min end-time slots.
 *
 * Writes accumulate in process memory (`Map<slot, Map<mode, diff>>`) and the
 * coordinator drains/flushes to Postgres every 60s. Reads keep querying the
 * same table as before. The chart-visibility cutoff in
 * `TimeSlotHelper.getChartVisibilityCutoffSlot()` guarantees the most
 * recent visible datapoint is fully flushed before it becomes chart-eligible.
 *
 * History: Originally direct PG per share — created row-lock hotspots on
 * the 3 current-slot rows. Was moved to Redis HINCRBYFLOAT to break the
 * lock contention, but the Redis SCAN/HGETALL/HINCRBYFLOAT-back dance
 * became its own perf problem (~36 % of total Redis CPU pool-wide).
 * Now lives in process memory: ~0 Redis ops on the hot path, single-threaded
 * Node guarantees atomicity without locks.
 */
@Injectable()
export class PoolModeHashrateService {

    /**
     * In-memory accumulator. Slot → mode → un-flushed diff. Backed by the
     * generic NestedDeltaBuffer — see src/utils/buffers.ts.
     */
    private readonly slotDeltas = new NestedDeltaBuffer<number, MiningMode>();

    constructor(
        @InjectRepository(PoolModeHashrateEntity)
        private readonly repo: Repository<PoolModeHashrateEntity>,
    ) {}

    /** Synchronous, non-throwing hot-path write. */
    incrementAccepted(mode: MiningMode, difficulty: number): void {
        if (!Number.isFinite(difficulty) || difficulty <= 0) return;
        if (difficulty > MAX_REASONABLE_DIFFICULTY) {
            console.warn(
                `[PoolModeHashrate] Discarded out-of-range share for ${mode}: diff=${difficulty} (limit ${MAX_REASONABLE_DIFFICULTY})`,
            );
            return;
        }
        this.slotDeltas.add(TimeSlotHelper.getCurrentSlot(), mode, difficulty);
    }

    drainSlotDeltas(): Map<number, Map<MiningMode, number>> {
        return this.slotDeltas.drain();
    }

    confirmFlush(flushed: Map<number, Map<MiningMode, number>>): void {
        this.slotDeltas.confirm(flushed);
    }

    /**
     * Chart data for a single mode over the given range in the shape
     * [{ label, data }]. Mirrors ClientStatisticsService.getChartDataForSite
     * exactly: end-time-labeled 10-min slots; just-ended / in-progress slots
     * hidden via `getChartVisibilityCutoffSlot()`; hashrate = shares × DIFFICULTY_1 / 600s.
     */
    async getChart(mode: MiningMode, range: '1d' | '3d' | '7d' = '1d'): Promise<{ label: string; data: number }[]> {
        const diffDays = range === '7d' ? 7 : range === '3d' ? 3 : 1;
        // Hide both the current in-progress slot AND the just-ended slot
        // until our flush mechanism has had a chance to fully commit it.
        const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot();
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
