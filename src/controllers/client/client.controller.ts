import { Controller, Get, NotFoundException, Param, Query, Post, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { eStratumErrorCode, STRATUM_REJECT_STALE } from '../../models/enums/eStratumErrorCode';
import { StratumV1Service } from '../../services/stratum-v1.service';
import { StratumV2Service } from '../../services/stratum-v2.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { WorkerSharesService } from '../../ORM/worker-shares/worker-shares.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';
import { generateFormattedTimeSlots } from '../../utils/timeslot.utils';


@Controller('client')
export class ClientController {

    // Configurable cache TTLs (in seconds)
    private readonly cacheTTL = {
        clientInfo: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_INFO') ?? '10'),        // Live data (workers, hashrate, difficulty)
        clientChart: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_CHART') ?? '60'),      // Historical chart data
        clientWorkerShares: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_WORKER_SHARES') ?? '15'), // Worker share totals
        clientWorkers: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_WORKERS') ?? '60'),  // Historical worker counts
        clientAccepted: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_ACCEPTED') ?? '60'), // Historical accepted shares
        clientRejected: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_REJECTED') ?? '60'), // Historical rejected shares
        clientDiffScores: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_DIFF_SCORES') ?? '300'), // Difficulty scores (5 min)
        clientWorkerGroup: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_WORKER_GROUP') ?? '60'), // Worker group info
        clientWorkerSession: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_WORKER_SESSION') ?? '60'), // Worker session info
    };

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly configService: ConfigService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
        private readonly stratumV1Service: StratumV1Service,
        private readonly stratumV2Service: StratumV2Service,
        private readonly shareTotalsCacheService: ShareTotalsCacheService,
        private readonly difficultyScoresCacheService: DifficultyScoresCacheService,
        private readonly trackerService: BestDifficultyTrackerService,
        private readonly workerSharesService: WorkerSharesService,
    ) { }


    @Get(':address')
    async getClientInfo(@Param('address') address: string) {

        const CACHE_KEY = `CLIENT_INFO_${address}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const [workers, addressSettings, totalShares] = await Promise.all([
            // Hot path — `getByAddressLight` skips TypeORM entity hydration
            // on Postgres (raw SELECT of only the 7 fields used below).
            // Saves the per-row `DateTimeTransformer.from` chain that the
            // 2026-05-13 prod CPU profile flagged at ~25-30 % of non-idle CPU.
            this.clientService.getByAddressLight(address),
            this.addressSettingsService.getSettings(address, false),
            this.shareTotalsCacheService.getAddressTotal(address),
        ]);
        const totalHashrate = workers.reduce((sum, w) => sum + (w.hashRate ?? 0), 0);
        const v1Difficulties = this.stratumV1Service.getCurrentDifficulties(address);
        const v2Difficulties = this.stratumV2Service.getCurrentDifficulties(address);
        const currentDifficulties = new Map([...v1Difficulties, ...v2Difficulties]);

        const result = {
            bestDifficulty: addressSettings?.bestDifficulty,
            workersCount: workers.length,
            totalShares,
            totalHashrate,
            workers: await Promise.all(
                workers.map(async (worker) => {
                    const liveDifficulty = worker.sessionId ? currentDifficulties.get(worker.sessionId) : undefined;
                    const persistedDifficultyRaw = worker.currentDifficulty;
                    const persistedDifficulty =
                        persistedDifficultyRaw == null ? null : Number(persistedDifficultyRaw);
                    const fallbackDifficulty =
                        persistedDifficulty != null && Number.isFinite(persistedDifficulty)
                            ? persistedDifficulty
                            : null;
                    const currentDifficulty =
                        liveDifficulty != null
                            ? liveDifficulty
                            : fallbackDifficulty;
                    return {
                        sessionId: worker.sessionId,
                        name: worker.clientName,
                        bestDifficulty: worker.bestDifficulty.toFixed(2),
                        hashRate: worker.hashRate,
                        currentDifficulty,
                        startTime: worker.startTime,
                        lastSeen: worker.updatedAt
                    };
                })
            )
        };

        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientInfo * 1000);
        return result;
    }

    @Post(':address/reset')
    async resetClients(@Param('address') address: string) {
        console.log(`[ClientController] Starting reset for address ${address}`);

        await this.stratumV1Service.resetBestDifficultyForAddress(address);
        await this.stratumV2Service.resetBestDifficultyForAddress(address);
        console.log(`[ClientController] Stratum reset completed for ${address}`);

        await this.addressSettingsService.updateBestDifficulty(address, 0, null);
        console.log(`[ClientController] AddressSettings reset completed for ${address}`);

        await this.trackerService.resetTracker(address);
        console.log(`[ClientController] Tracker reset completed for ${address}`);

        return { status: 'reset' };
    }

    @Post(':address/delete-stats')
    async deleteStats(@Param('address') address: string) {
        console.log(`[ClientController] Starting delete-stats for address ${address}`);

        // Clear all cache keys for this address (including worker-specific caches)
        // Try to get Redis client to use keys() for pattern matching
        try {
            const store: any = this.cacheManager.store;
            if (store && store.client) {
                const redisClient = store.client;
                // Find all cache keys containing this address
                const patterns = [
                    `CLIENT_INFO_${address}*`,
                    `CLIENT_CHART_${address}*`,
                    `CLIENT_CHART_LIVE_${address}*`,
                    `CLIENT_WORKER_SHARES_${address}*`,
                    `CLIENT_WORKERS_${address}*`,
                    `CLIENT_ACCEPTED_${address}*`,
                    `CLIENT_REJECTED_${address}*`,
                    `CLIENT_DIFF_SCORES_${address}*`,
                    `CLIENT_WORKER_GROUP_${address}*`,
                    `CLIENT_WORKER_SESSION_${address}*`,
                ];

                for (const pattern of patterns) {
                    let cursor = '0';
                    do {
                        const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 1000 });
                        cursor = result.cursor.toString();
                        if (result.keys.length > 0) {
                            await redisClient.del(result.keys);
                        }
                    } while (cursor !== '0');
                }
                console.log(`[ClientController] Cache keys cleared for ${address}`);
            }
        } catch (error) {
            console.error(`[ClientController] Error clearing cache keys:`, error);
            // Fallback: clear known cache keys
            const cacheKeys = [
                `CLIENT_INFO_${address}`,
                `CLIENT_CHART_${address}_1d`,
                `CLIENT_CHART_${address}_3d`,
                `CLIENT_CHART_${address}_7d`,
                `CLIENT_CHART_LIVE_${address}_1h`,
                `CLIENT_CHART_LIVE_${address}_6h`,
                `CLIENT_CHART_LIVE_${address}_12h`,
                `CLIENT_CHART_LIVE_${address}_24h`,
                `CLIENT_WORKER_SHARES_${address}`,
                `CLIENT_WORKERS_${address}_1d`,
                `CLIENT_WORKERS_${address}_3d`,
                `CLIENT_WORKERS_${address}_7d`,
                `CLIENT_ACCEPTED_${address}_1d`,
                `CLIENT_ACCEPTED_${address}_3d`,
                `CLIENT_ACCEPTED_${address}_7d`,
                `CLIENT_REJECTED_${address}_1d`,
                `CLIENT_REJECTED_${address}_3d`,
                `CLIENT_REJECTED_${address}_7d`,
                `CLIENT_DIFF_SCORES_${address}_1d`,
                `CLIENT_DIFF_SCORES_${address}_7d`,
                `CLIENT_DIFF_SCORES_${address}_30d`,
            ];
            await Promise.all(cacheKeys.map(key => this.cacheManager.del(key)));
        }

        // Clear Redis keys for statistics
        await this.clientStatisticsService.clearRedisKeysForAddress(address);
        await this.clientRejectedStatisticsService.clearRedisKeysForAddress(address);
        await this.shareTotalsCacheService.clearAddressData(address);
        await this.workerSharesService.deleteForAddress(address);
        console.log(`[ClientController] Redis keys and worker totals cleared for ${address}`);

        // Delete statistics from database
        await this.clientStatisticsService.deleteForAddress(address);
        console.log(`[ClientController] Client statistics deleted for ${address}`);

        await this.clientRejectedStatisticsService.deleteForAddress(address);
        console.log(`[ClientController] Client rejected statistics deleted for ${address}`);

        await this.clientDifficultyStatisticsService.deleteForAddress(address);
        console.log(`[ClientController] Client difficulty statistics deleted for ${address}`);

        // Reset best difficulty tracking
        await this.stratumV1Service.resetBestDifficultyForAddress(address);
        await this.stratumV2Service.resetBestDifficultyForAddress(address);
        await this.addressSettingsService.updateBestDifficulty(address, 0, null);
        await this.trackerService.resetTracker(address);
        console.log(`[ClientController] Best difficulty tracking reset for ${address}`);

        return { status: 'stats-deleted', address };
    }

    @Post(':address/delete-all')
    async deleteAll(@Param('address') address: string) {
        console.log(`[ClientController] Starting delete-all for address ${address}`);

        // First delete all statistics (reuse delete-stats logic)
        await this.deleteStats(address);

        // Delete client records (hard delete)
        await this.clientService.hardDeleteForAddress(address);
        console.log(`[ClientController] Client records deleted for ${address}`);

        // Delete address settings
        await this.addressSettingsService.deleteForAddress(address);
        console.log(`[ClientController] Address settings deleted for ${address}`);

        // Delete tracker
        await this.trackerService.deleteTracker(address);
        console.log(`[ClientController] Tracker deleted for ${address}`);

        return { status: 'all-deleted', address };
    }

    @Get(':address/chart')
    async getClientInfoChart(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const CACHE_KEY = `CLIENT_CHART_${address}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const chartData = await this.clientStatisticsService.getChartDataForAddress(address, range);
        await this.cacheManager.set(CACHE_KEY, chartData, this.cacheTTL.clientChart * 1000);
        return chartData;
    }

    @Get(':address/worker-shares')
    async getWorkerShares(@Param('address') address: string) {
        const CACHE_KEY = `CLIENT_WORKER_SHARES_${address}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const [workerShares, dbWorkerTotals] = await Promise.all([
            this.shareTotalsCacheService.getWorkerTotals(address),
            // Hot path — `getWorkerTotalsLight` returns only (clientName,
            // rejectedShares) via raw query on Postgres, no entity hydration.
            this.workerSharesService.getWorkerTotalsLight(address),
        ]);

        // Create a map for quick lookup of rejected counts (PK lookup, no full scan)
        const rejectedMap = new Map(dbWorkerTotals.map(w => [w.clientName, w.rejectedShares]));

        const result = workerShares.map(ws => ({
            workerName: ws.workerName,
            totalShares: ws.total,
            totalRejected: rejectedMap.get(ws.workerName) || 0
        }));

        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientWorkerShares * 1000);
        return result;
    }

    @Get(':address/workers')
    async getAddressWorkers(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const CACHE_KEY = `CLIENT_WORKERS_${address}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
        const sinceTime = now - days * oneDay;

        const entries = await this.clientStatisticsService.getActiveCountsForAddress(address, sinceTime);
        const slotMap = new Map<number, { workers: number; sessions: number }>();
        for (const entry of entries) {
            slotMap.set(entry.time, { workers: entry.workers, sessions: entry.sessions });
        }

        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => ({
            counts: slotMap.get(t) || { workers: 0, sessions: 0 },
        }));

        const result = { slotData };
        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientWorkers * 1000);
        return result;
    }

    @Get(':address/accepted')
    async getAddressAccepted(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const CACHE_KEY = `CLIENT_ACCEPTED_${address}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
        const sinceTime = now - days * oneDay;

        const entries = await this.clientStatisticsService.getAcceptedEntriesSince(address, sinceTime);
        const slotMap = new Map<number, number>();
        for (const entry of entries) {
            slotMap.set(entry.time, entry.shares);
        }

        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => ({
            counts: { accepted: slotMap.get(t) || 0 }
        }));

        const result = { slotData };
        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientAccepted * 1000);
        return result;
    }

    @Get(':address/rejected')
    async getAddressRejected(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const CACHE_KEY = `CLIENT_REJECTED_${address}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
        const sinceTime = now - days * oneDay;

        const entries = await this.clientRejectedStatisticsService.getEntriesSince(address, sinceTime);
        const slotMap = new Map<number, Record<string, { count: number; diffMinusOne: number }>>();
        for (const entry of entries) {
            if (!slotMap.has(entry.time)) {
                slotMap.set(entry.time, {});
            }
            const r = slotMap.get(entry.time);
            r[entry.reason] = { count: entry.count, diffMinusOne: entry.shares };
        }

        // See app.controller `infoRejected` for rationale — Stale is
        // tracked alongside the wire-level rejection codes.
        const allReasons = [
            ...Object.keys(eStratumErrorCode).filter(k => isNaN(Number(k))),
            STRATUM_REJECT_STALE,
        ];
        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => {
            const counts: Record<string, { count: number; diffMinusOne: number }> = {};
            for (const reason of allReasons) {
                const current = slotMap.get(t)?.[reason] || { count: 0, diffMinusOne: 0 };
                counts[reason] = current;
            }
            return { counts };
        });

        const result = { slotData };
        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientRejected * 1000);
        return result;
    }

    @Get(':address/diff-scores')
    async getAddressDifficultyScores(
        @Param('address') address: string,
        @Query('range') range: '1d' | '7d' | '30d' = '1d'
    ) {
        const CACHE_KEY = `CLIENT_DIFF_SCORES_${address}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        let hours = 24;
        switch (range) {
            case '30d':
                hours = 24 * 30;
                break;
            case '7d':
                hours = 24 * 7;
                break;
            default:
                hours = 24;
        }

        const since = now - hours * oneHour;
        const startSlot = Math.floor(since / oneHour) * oneHour;
        const endSlot = Math.floor(now / oneHour) * oneHour;

        const result = await this.difficultyScoresCacheService.getDifficultyScores(
            address,
            range,
            startSlot,
            endSlot,
        );
        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientDiffScores * 1000);
        return result;
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(
        @Param('address') address: string,
        @Param('workerName') workerName: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d',
    ) {
        const CACHE_KEY = `CLIENT_WORKER_GROUP_${address}_${workerName}_${range}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const workers = await this.clientService.getByNameLight(address, workerName);

        const bestDifficulty = workers.reduce((pre, cur) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName, range);
        const result = {
            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            chartData: chartData,
        };

        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientWorkerGroup * 1000);
        return result;
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {
        const CACHE_KEY = `CLIENT_WORKER_SESSION_${address}_${workerName}_${sessionId}`;
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (cachedResult != null) {
            return cachedResult;
        }

        const worker = await this.clientService.getBySessionIdLight(address, workerName, sessionId);
        if (worker == null) {
            return new NotFoundException();
        }
        const chartData = await this.clientStatisticsService.getChartDataForSession(worker.address, worker.clientName, worker.sessionId);

        const result = {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            chartData: chartData,
            startTime: worker.startTime
        };

        await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.clientWorkerSession * 1000);
        return result;
    }
}
