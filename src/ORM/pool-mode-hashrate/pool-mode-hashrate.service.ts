import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import type { MiningMode } from '../../services/mining-mode.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import {
    DIFFICULTY_1,
    MAX_REASONABLE_DIFFICULTY,
    REDIS_STATISTICS_TTL,
    SLOT_DURATION_MS,
} from '../../constants/mining.constants';

/**
 * Per-mode pool-wide hashrate stats, keyed on the same 10-min end-time slots
 * as `client_statistics` (see TimeSlotHelper). Driven by every accepted share
 * after the stratum layer's routing decision; queried by /api/info/chart/mode
 * and /api/pplns/chart. Same slot convention + same hashrate formula as
 * ClientStatisticsService so splash curves align to one x-axis.
 *
 * Writes go through Redis — `HINCRBYFLOAT pool:mode-hashrate:{slot} {mode}` —
 * and StatisticsCoordinatorService bulk-flushes to Postgres every 60s. The
 * previous implementation wrote directly to Postgres on every share, which
 * created a row-lock hotspot on the 3 mode rows of the current slot under
 * sustained load (~250 shares/s pool-wide → 250 UPDATEs/s on 3 rows). That
 * starved the 10-connection PG pool and bled into `pool_share_statistics`
 * coordinator flushes (which then dropped slots on /api/info/chart). Moving
 * the writer onto the Redis-buffer pattern shared by every other per-share
 * counter eliminates the contention; reads keep querying the same table
 * unchanged.
 */
@Injectable()
export class PoolModeHashrateService implements OnModuleInit {

    constructor(
        @InjectRepository(PoolModeHashrateEntity)
        private readonly repo: Repository<PoolModeHashrateEntity>,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    ) {}

    private redisClient: any = null;

    async onModuleInit(): Promise<void> {
        try {
            const store: any = this.cacheManager.store;
            if (store && store.client) {
                this.redisClient = store.client;
                console.log('[PoolModeHashrate] Using Redis for atomic per-share increments; coordinator flushes to Postgres every 60s');
            } else {
                console.error('[PoolModeHashrate] Redis not available — per-share mode-hashrate writes will be silently dropped');
            }
        } catch (err) {
            console.error('[PoolModeHashrate] Failed to access Redis client:', err);
        }
    }

    /**
     * Add `difficulty` to the current end-time slot for `mode`. Atomic
     * Redis hincrby; coordinator picks up the slot once it's complete and
     * bulk-upserts into `pool_mode_hashrate`.
     *
     * Errors are swallowed so a failed stats write never blocks a share
     * submit — same behaviour as before, just on a different storage.
     */
    async incrementAccepted(mode: MiningMode, difficulty: number): Promise<void> {
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

        if (!this.redisClient) return;

        const slot = TimeSlotHelper.getCurrentSlot();
        const key = `pool:mode-hashrate:${slot}`;

        try {
            // hash field per mode so all 3 modes for the same slot share
            // one Redis key — coordinator can flush them in a single
            // hGetAll round-trip per slot.
            await Promise.all([
                this.redisClient.hIncrByFloat(key, mode, difficulty),
                this.redisClient.expire(key, REDIS_STATISTICS_TTL),
            ]);
        } catch (err) {
            console.warn(`[PoolModeHashrate] Redis increment failed for ${mode}:`, (err as Error).message);
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
