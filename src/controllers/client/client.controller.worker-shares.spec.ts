import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';

jest.mock('node-telegram-bot-api', () => ({}));

import { ClientController } from './client.controller';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { StratumV1Service } from '../../services/stratum-v1.service';
import { StratumV2Service } from '../../services/stratum-v2.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { WorkerSharesService } from '../../ORM/worker-shares/worker-shares.service';
import { LiveHashrateService } from '../../services/live-hashrate.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';

describe('ClientController GET :address/worker-shares', () => {
    let app: NestFastifyApplication;
    let cacheManager: { get: jest.Mock; set: jest.Mock };
    let shareTotalsCacheService: { getWorkerTotals: jest.Mock };
    let workerSharesService: { getWorkerTotals: jest.Mock };

    beforeEach(async () => {
        cacheManager = {
            get: jest.fn().mockResolvedValue(null), // cache miss by default
            set: jest.fn().mockResolvedValue(undefined),
        };
        shareTotalsCacheService = {
            getWorkerTotals: jest.fn(),
        };
        workerSharesService = {
            getWorkerTotals: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [ClientController],
            providers: [
                { provide: CACHE_MANAGER, useValue: cacheManager },
                { provide: ConfigService, useValue: { get: jest.fn() } },
                { provide: ClientService, useValue: {} },
                { provide: ClientStatisticsService, useValue: {} },
                { provide: AddressSettingsService, useValue: {} },
                { provide: ClientRejectedStatisticsService, useValue: {} },
                { provide: ClientDifficultyStatisticsService, useValue: {} },
                { provide: BestDifficultyTrackerService, useValue: {} },
                { provide: StratumV1Service, useValue: {} },
                { provide: StratumV2Service, useValue: {} },
                { provide: ShareTotalsCacheService, useValue: shareTotalsCacheService },
                { provide: WorkerSharesService, useValue: workerSharesService },
                { provide: LiveHashrateService, useValue: {} },
                { provide: DifficultyScoresCacheService, useValue: {} },
            ],
        }).compile();

        app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        app.setGlobalPrefix('api');
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    });

    afterEach(async () => {
        await app.close();
    });

    it('returns totalRejected from workerSharesService (PK lookup, not full scan)', async () => {
        shareTotalsCacheService.getWorkerTotals.mockResolvedValue([
            { workerName: 'rig1', total: 1000 },
            { workerName: 'rig2', total: 500 },
        ]);
        workerSharesService.getWorkerTotals.mockResolvedValue([
            { clientName: 'rig1', shares: 1000, rejectedShares: 42 },
            { clientName: 'rig2', shares: 500, rejectedShares: 7 },
        ]);

        const res = await app.inject({ method: 'GET', url: '/api/client/addr1/worker-shares' });

        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.payload);
        expect(payload).toEqual([
            { workerName: 'rig1', totalShares: 1000, totalRejected: 42 },
            { workerName: 'rig2', totalShares: 500, totalRejected: 7 },
        ]);
    });

    it('sets totalRejected to 0 when worker has no entry in worker_shares_entity', async () => {
        shareTotalsCacheService.getWorkerTotals.mockResolvedValue([
            { workerName: 'rig1', total: 300 },
        ]);
        // worker_shares_entity has no row for this address yet (e.g. first deploy)
        workerSharesService.getWorkerTotals.mockResolvedValue([]);

        const res = await app.inject({ method: 'GET', url: '/api/client/addr1/worker-shares' });

        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.payload);
        expect(payload).toEqual([{ workerName: 'rig1', totalShares: 300, totalRejected: 0 }]);
    });

    it('returns the cached result without calling services again', async () => {
        const cached = [{ workerName: 'rig1', totalShares: 999, totalRejected: 5 }];
        cacheManager.get.mockResolvedValue(cached);

        const res = await app.inject({ method: 'GET', url: '/api/client/addr1/worker-shares' });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual(cached);
        expect(shareTotalsCacheService.getWorkerTotals).not.toHaveBeenCalled();
        expect(workerSharesService.getWorkerTotals).not.toHaveBeenCalled();
    });

    it('stores the result in cache after a miss', async () => {
        shareTotalsCacheService.getWorkerTotals.mockResolvedValue([{ workerName: 'rig1', total: 100 }]);
        workerSharesService.getWorkerTotals.mockResolvedValue([{ clientName: 'rig1', shares: 100, rejectedShares: 3 }]);

        await app.inject({ method: 'GET', url: '/api/client/addr1/worker-shares' });

        expect(cacheManager.set).toHaveBeenCalledWith(
            'CLIENT_WORKER_SHARES_addr1',
            [{ workerName: 'rig1', totalShares: 100, totalRejected: 3 }],
            expect.any(Number),
        );
    });
});
