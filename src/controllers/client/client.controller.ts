import { Controller, Get, Patch, Body, UnauthorizedException, NotFoundException, Param } from '@nestjs/common';
import * as bitcoinMessage from 'bitcoinjs-message';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';


@Controller('client')
export class ClientController {

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService
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
    async getClientInfoChart(@Param('address') address: string) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address);
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

    @Patch(':address/reset-shares')
    async resetShares(
        @Param('address') address: string,
        @Body('message') message: string,
        @Body('signature') signature: string,
    ) {
        if (!bitcoinMessage.verify(message, address, signature)) {
            throw new UnauthorizedException('Invalid signature');
        }
        await this.clientStatisticsService.resetSharesForAddress(address);
        return { success: true };
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
