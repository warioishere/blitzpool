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
import { StratumV1Service } from '../../services/stratum-v1.service';
import { StratumV2Service } from '../../services/stratum-v2.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { LiveHashrateService } from '../../services/live-hashrate.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { WorkerSharesService } from '../../ORM/worker-shares/worker-shares.service';

describe('ClientController worker chart data', () => {
  let app: NestFastifyApplication;
  let clientStatisticsService: { getChartDataForGroup: jest.Mock };
  let clientService: { getByName: jest.Mock };

  beforeEach(async () => {
    clientStatisticsService = {
      getChartDataForGroup: jest.fn().mockResolvedValue([
        {
          label: '2023-11-14T00:00:00.000Z',
          data: 100,
          accepted: 4294967296,
          rejectedJobNotFound: 1,
          rejectedJobNotFoundDiff1: 2000,
          rejectedDuplicatedShare: 0,
          rejectedDuplicatedShareDiff1: 0,
          rejectedLowDifficultyShare: 2,
          rejectedLowDifficultyShareDiff1: 4000,
        },
      ]),
    };
    clientService = {
      getByName: jest.fn().mockResolvedValue([
        { bestDifficulty: 12.34 },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientController],
      providers: [
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ClientService, useValue: clientService },
        { provide: ClientStatisticsService, useValue: clientStatisticsService },
        { provide: AddressSettingsService, useValue: {} },
        { provide: ClientRejectedStatisticsService, useValue: {} },
        { provide: ClientDifficultyStatisticsService, useValue: {} },
        { provide: StratumV1Service, useValue: {} },
        { provide: StratumV2Service, useValue: {} },
        { provide: ShareTotalsCacheService, useValue: {} },
        { provide: LiveHashrateService, useValue: {} },
        { provide: DifficultyScoresCacheService, useValue: {} },
        { provide: BestDifficultyTrackerService, useValue: {} },
        { provide: WorkerSharesService, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns worker info including accepted and rejected share totals for a requested range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/workerA?range=7d',
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.chartData).toEqual([
      {
        label: '2023-11-14T00:00:00.000Z',
        data: 100,
        accepted: 4294967296,
        rejectedJobNotFound: 1,
        rejectedJobNotFoundDiff1: 2000,
        rejectedDuplicatedShare: 0,
        rejectedDuplicatedShareDiff1: 0,
        rejectedLowDifficultyShare: 2,
        rejectedLowDifficultyShareDiff1: 4000,
      },
    ]);
    expect(clientStatisticsService.getChartDataForGroup).toHaveBeenCalledWith(
      'addr123',
      'workerA',
      '7d',
    );
  });

  it('defaults to returning one day of chart data when no range is specified', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/workerA',
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.chartData).toEqual([
      {
        label: '2023-11-14T00:00:00.000Z',
        data: 100,
        accepted: 4294967296,
        rejectedJobNotFound: 1,
        rejectedJobNotFoundDiff1: 2000,
        rejectedDuplicatedShare: 0,
        rejectedDuplicatedShareDiff1: 0,
        rejectedLowDifficultyShare: 2,
        rejectedLowDifficultyShareDiff1: 4000,
      },
    ]);
    const lastCall =
      clientStatisticsService.getChartDataForGroup.mock.calls[
        clientStatisticsService.getChartDataForGroup.mock.calls.length - 1
      ];
    expect(lastCall).toEqual(['addr123', 'workerA', '1d']);
  });
});
