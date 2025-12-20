import { Controller, Get, NotFoundException, Param, Query, Post } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { eStratumErrorCode } from '../../models/enums/eStratumErrorCode';
import { StratumV1Service } from '../../services/stratum-v1.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { LiveHashrateService } from '../../services/live-hashrate.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';
import { generateFormattedTimeSlots } from '../../utils/timeslot.utils';


@Controller('client')
export class ClientController {

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
        private readonly stratumV1Service: StratumV1Service,
        private readonly shareTotalsCacheService: ShareTotalsCacheService,
        private readonly liveHashrateService: LiveHashrateService,
        private readonly difficultyScoresCacheService: DifficultyScoresCacheService,
        private readonly trackerService: BestDifficultyTrackerService,
    ) { }


    @Get(':address')
    async getClientInfo(@Param('address') address: string) {

        const workers = await this.clientService.getByAddress(address);

        const addressSettings = await this.addressSettingsService.getSettings(address, false);

        const totalShares = await this.shareTotalsCacheService.getAddressTotal(address);
        const totalHashrate = workers.reduce((sum, w) => sum + (w.hashRate ?? 0), 0);
        const currentDifficulties = this.stratumV1Service.getCurrentDifficulties(address);

        return {
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
        }
    }

    @Post(':address/reset')
    async resetClients(@Param('address') address: string) {
        console.log(`[ClientController] Starting reset for address ${address}`);

        await this.stratumV1Service.resetBestDifficultyForAddress(address);
        console.log(`[ClientController] StratumV1Service reset completed for ${address}`);

        await this.addressSettingsService.updateBestDifficulty(address, 0, null);
        console.log(`[ClientController] AddressSettings reset completed for ${address}`);

        await this.trackerService.resetTracker(address);
        console.log(`[ClientController] Tracker reset completed for ${address}`);

        return { status: 'reset' };
    }

    @Get(':address/chart')
    async getClientInfoChart(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address, range);
        return chartData;
    }

    @Get(':address/chart/live')
    async getClientInfoChartLive(
        @Param('address') address: string,
        @Query('range') range: '1h' | '6h' | '12h' | '24h' = '1h'
    ) {
        // Parse range to hours
        const hours = range === '24h' ? 24 : range === '12h' ? 12 : range === '6h' ? 6 : 1;
        const chartData = await this.liveHashrateService.getAddressLiveHashrate(address, hours);
        return chartData;
    }

    @Get(':address/worker-shares')
    async getWorkerShares(@Param('address') address: string) {
        const workerShares = await this.shareTotalsCacheService.getWorkerTotals(address);
        return workerShares.map(ws => ({ workerName: ws.workerName, totalShares: ws.total }));
    }

    @Get(':address/workers')
    async getAddressWorkers(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
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

        return { slotData };
    }

    @Get(':address/accepted')
    async getAddressAccepted(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
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

        return { slotData };
    }

    @Get(':address/rejected')
    async getAddressRejected(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
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

        const allReasons = Object.keys(eStratumErrorCode).filter(k => isNaN(Number(k)));
        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => {
            const counts: Record<string, { count: number; diffMinusOne: number }> = {};
            for (const reason of allReasons) {
                const current = slotMap.get(t)?.[reason] || { count: 0, diffMinusOne: 0 };
                counts[reason] = current;
            }
            return { counts };
        });

        return { slotData };
    }

    @Get(':address/diff-scores')
    async getAddressDifficultyScores(
        @Param('address') address: string,
        @Query('range') range: '1d' | '7d' | '30d' = '1d'
    ) {
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

        return this.difficultyScoresCacheService.getDifficultyScores(
            address,
            range,
            startSlot,
            endSlot,
        );
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(
        @Param('address') address: string,
        @Param('workerName') workerName: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d',
    ) {

        const workers = await this.clientService.getByName(address, workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName, range);
        return {

            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            chartData: chartData,

        }
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {

        const worker = await this.clientService.getBySessionId(address, workerName, sessionId);
        if (worker == null) {
            return new NotFoundException();
        }
        const chartData = await this.clientStatisticsService.getChartDataForSession(worker.address, worker.clientName, worker.sessionId);

        return {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            chartData: chartData,
            startTime: worker.startTime
        }
    }
}
