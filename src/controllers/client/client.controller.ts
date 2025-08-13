/* eslint-disable prettier/prettier */
import { Controller, Get, NotFoundException, Param, Query, Post } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { eStratumErrorCode } from '../../models/enums/eStratumErrorCode';
import { StratumV1Service } from '../../services/stratum-v1.service';


@Controller('client')
export class ClientController {

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly stratumV1Service: StratumV1Service,
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

    @Post(':address/reset')
    resetClients(@Param('address') address: string) {
        this.stratumV1Service.resetClientsForAddress(address);
        return { status: 'reset' };
    }

    @Get(':address/chart')
    async getClientInfoChart(
        @Param('address') address: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d'
    ) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address, range);

        const coeff = 1000 * 60 * 10;
        const currentSlot = Math.floor(Date.now() / coeff) * coeff;
        const liveClients = this.stratumV1Service.getClientsByAddress(address);
        let liveHashRate = 0;

        for (const client of liveClients) {
            if (client.statistics.currentTimeSlot === currentSlot) {
                liveHashRate += client.statistics.hashRate;
            }
        }

        chartData.push({ label: new Date(currentSlot).toISOString(), data: liveHashRate });
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

        const coeff = 1000 * 60 * 10;
        const startSlot = Math.floor(sinceTime / coeff) * coeff;
        const endSlot = Math.floor(now / coeff) * coeff;

        const liveClients = this.stratumV1Service.getClientsByAddress(address);
        for (const client of liveClients) {
            const slot = client.statistics.currentTimeSlot;
            if (slot != null && slot >= startSlot) {
                const unsavedShares = client.statistics.shares - client.statistics.savedShares;
                slotMap.set(slot, (slotMap.get(slot) || 0) + unsavedShares);
            }
        }

        const slotData: { time: string; counts: { accepted: number } }[] = [];
        for (let t = startSlot; t <= endSlot; t += coeff) {
            slotData.push({ time: new Date(t).toISOString(), counts: { accepted: slotMap.get(t) || 0 } });
        }

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
