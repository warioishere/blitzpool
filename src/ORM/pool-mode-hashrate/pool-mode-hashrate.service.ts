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
     * In-memory accumulator. `slotDeltas.get(slot).get(mode)` is the
     * un-flushed delta for that mode in that slot. Coordinator drains all
     * slots on its 60s tick, including the current in-progress slot
     * (which the chart filter hides until 60s after it ends anyway).
     */
    private readonly slotDeltas = new Map<number, Map<MiningMode, number>>();

    constructor(
        @InjectRepository(PoolModeHashrateEntity)
        private readonly repo: Repository<PoolModeHashrateEntity>,
    ) {}

    /**
     * Add `difficulty` to the current end-time slot for `mode`. Synchronous,
     * non-throwing — failed stats writes must never block share submission.
     */
    incrementAccepted(mode: MiningMode, difficulty: number): void {
        if (!Number.isFinite(difficulty) || difficulty <= 0) return;

        // Defense-in-depth ceiling. The PG `pool_mode_hashrate.diff` column
        // is `real` (max ~3.4e38). A misconfigured SV2 client opening a
        // channel with absurdly small maxTarget gets assigned diff in the
        // e+50 range — flushing such a value would overflow the column and
        // poison the slot. Mirrors the same guard in PoolShareStatistics.
        if (difficulty > MAX_REASONABLE_DIFFICULTY) {
            console.warn(
                `[PoolModeHashrate] Discarded out-of-range share for ${mode}: diff=${difficulty} (limit ${MAX_REASONABLE_DIFFICULTY})`,
            );
            return;
        }

        const slot = TimeSlotHelper.getCurrentSlot();
        let modeMap = this.slotDeltas.get(slot);
        if (!modeMap) {
            modeMap = new Map();
            this.slotDeltas.set(slot, modeMap);
        }
        modeMap.set(mode, (modeMap.get(mode) ?? 0) + difficulty);
    }

    /**
     * Coordinator API — return a snapshot of all currently-pending slot
     * deltas. Internal map is NOT cleared; `confirmFlush()` must be called
     * after the PG upsert succeeds. Any shares that arrive between drain
     * and confirm are preserved as residuals.
     */
    drainSlotDeltas(): Map<number, Map<MiningMode, number>> {
        const snapshot = new Map<number, Map<MiningMode, number>>();
        for (const [slot, modeMap] of this.slotDeltas) {
            const copy = new Map<MiningMode, number>();
            for (const [mode, diff] of modeMap) {
                if (diff > 0) copy.set(mode, diff);
            }
            if (copy.size > 0) snapshot.set(slot, copy);
        }
        return snapshot;
    }

    /**
     * Coordinator API — subtract a previously-drained snapshot. Residuals
     * (concurrent increments that happened during the await) remain.
     */
    confirmFlush(flushed: Map<number, Map<MiningMode, number>>): void {
        for (const [slot, modeMap] of flushed) {
            const current = this.slotDeltas.get(slot);
            if (!current) continue;
            for (const [mode, flushedAmount] of modeMap) {
                const have = current.get(mode) ?? 0;
                const residual = have - flushedAmount;
                if (residual <= 0) {
                    current.delete(mode);
                } else {
                    current.set(mode, residual);
                }
            }
            if (current.size === 0) {
                this.slotDeltas.delete(slot);
            }
        }
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
