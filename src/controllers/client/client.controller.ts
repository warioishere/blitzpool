import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { NumberSuffix } from '../../utils/NumberSuffix';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { eStratumErrorCode } from '../../models/enums/eStratumErrorCode';


@Controller('client')
export class ClientController {

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService
    ) { }


    @Get(':address')
    async getClientInfo(@Param('address') address: string) {

        const workers = await this.clientService.getByAddress(address);

        const addressSettings = await this.addressSettingsService.getSettings(address, false);

        return {
            bestDifficulty: addressSettings?.bestDifficulty,
            workersCount: workers.length,
            workers: await Promise.all(
                workers.map(async (worker) => {
                    return {
                        sessionId: worker.sessionId,
                        name: worker.clientName,
                        bestDifficulty: worker.bestDifficulty.toFixed(2),
                        hashRate: worker.hashRate,
                        startTime: worker.startTime,
                        lastSeen: worker.updatedAt
                    };
                })
            )
        }
    }

    @Get(':address/chart')
    async getClientInfoChart(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address, range);
        return chartData;
    }

    @Get(':address/shares')
    async getAddressShares(@Param('address') address: string) {
        const totalShares = await this.clientStatisticsService.getTotalSharesForAddress(address);
        return { totalShares };
    }

    @Get(':address/worker-shares')
    async getWorkerShares(@Param('address') address: string) {
        const workerShares = await this.clientStatisticsService.getTotalSharesForWorkers(address);
        return workerShares.map(ws => ({ workerName: ws.clientName, totalShares: ws.total }));
    }

    @Get(':address/stats')
    async getAddressStats(@Param('address') address: string) {
        const CACHE_KEY = `CLIENT_STATS_${address}`;
        const cached = await this.cacheManager.get(CACHE_KEY);
        if (cached) {
            return cached;
        }
        const suffix = new NumberSuffix();
        const workers = await this.clientService.getByAddress(address);
        const shares = await this.clientStatisticsService.getTotalSharesForAddress(address);
        const rejectedTotals = await this.clientRejectedStatisticsService.getTotalsSince(address, 0);
        const rejected = Object.values(rejectedTotals).reduce((a, b) => a + b, 0);
        const addrSettings = await this.addressSettingsService.getSettings(address, false);
        const now = Date.now();
        const hashrate1m = await this.clientStatisticsService.getHashRateSince(address, now - 60 * 1000);
        const hashrate5m = await this.clientStatisticsService.getHashRateSince(address, now - 5 * 60 * 1000);
        const hashrate1hr = await this.clientStatisticsService.getHashRateSince(address, now - 60 * 60 * 1000);
        const hashrate1d = await this.clientStatisticsService.getHashRateSince(address, now - 24 * 60 * 60 * 1000);
        const hashrate7d = await this.clientStatisticsService.getHashRateSince(address, now - 7 * 24 * 60 * 60 * 1000);
        const lastshare = await this.clientStatisticsService.getLastShareTime(address);

        const workerShareTotals = await this.clientStatisticsService.getTotalSharesForWorkers(address);

        const workerStats = await Promise.all(
            workers.map(async (worker) => {
                const wShares = workerShareTotals.find(w => w.clientName === worker.clientName)?.total || 0;
                const wRejectedTotals = await this.clientRejectedStatisticsService.getTotalsSince(address, 0, worker.clientName);
                const wRejected = Object.values(wRejectedTotals).reduce((a, b) => a + b, 0);
                return {
                    workername: worker.clientName,
                    hashrate1m: suffix.to(await this.clientStatisticsService.getHashRateSince(address, now - 60 * 1000, worker.clientName)),
                    hashrate5m: suffix.to(await this.clientStatisticsService.getHashRateSince(address, now - 5 * 60 * 1000, worker.clientName)),
                    hashrate1hr: suffix.to(await this.clientStatisticsService.getHashRateSince(address, now - 60 * 60 * 1000, worker.clientName)),
                    hashrate1d: suffix.to(await this.clientStatisticsService.getHashRateSince(address, now - 24 * 60 * 60 * 1000, worker.clientName)),
                    hashrate7d: suffix.to(await this.clientStatisticsService.getHashRateSince(address, now - 7 * 24 * 60 * 60 * 1000, worker.clientName)),
                    lastshare: await this.clientStatisticsService.getLastShareTime(address, worker.clientName),
                    shares: wShares,
                    rejected: wRejected,
                    bestshare: worker.bestDifficulty,
                    bestever: worker.bestDifficulty
                };
            })
        );

        const data = {
            hashrate1m: suffix.to(hashrate1m),
            hashrate5m: suffix.to(hashrate5m),
            hashrate1hr: suffix.to(hashrate1hr),
            hashrate1d: suffix.to(hashrate1d),
            hashrate7d: suffix.to(hashrate7d),
            lastshare: lastshare,
            workers: workers.length,
            shares,
            rejected,
            bestshare: addrSettings?.bestDifficulty || 0,
            bestever: addrSettings?.bestDifficulty || 0,
            worker: workerStats
        };

        await this.cacheManager.set(CACHE_KEY, data, 60);
        return data;
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
        const slotMap = new Map<number, Record<string, number>>();
        for (const entry of entries) {
            if (!slotMap.has(entry.time)) {
                slotMap.set(entry.time, {});
            }
            const r = slotMap.get(entry.time);
            r[entry.reason] = entry.count;
        }

        const coeff = 1000 * 60 * 10;
        const startSlot = Math.floor(sinceTime / coeff) * coeff;
        const endSlot = Math.floor(now / coeff) * coeff;
        const allReasons = Object.keys(eStratumErrorCode).filter(k => isNaN(Number(k)));
        const slotData: { time: string; counts: Record<string, number> }[] = [];
        for (let t = startSlot; t <= endSlot; t += coeff) {
            const counts: Record<string, number> = {};
            for (const reason of allReasons) {
                counts[reason] = slotMap.get(t)?.[reason] || 0;
            }
            slotData.push({ time: new Date(t).toISOString(), counts });
        }

        return { slotData };
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(@Param('address') address: string, @Param('workerName') workerName: string) {

        const workers = await this.clientService.getByName(address, workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName);
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
