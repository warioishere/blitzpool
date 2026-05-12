import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { REDIS_CLIENT } from '../../providers/redis-client.provider';
import { ConfigService } from '@nestjs/config';

jest.mock('node-telegram-bot-api', () => ({}));

import { ClientController } from './client.controller';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { StratumV1Service } from '../../services/stratum-v1.service';
import { StratumV2Service } from '../../services/stratum-v2.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { WorkerSharesService } from '../../ORM/worker-shares/worker-shares.service';

describe('ClientController difficulty scores', () => {
  let app: NestFastifyApplication;
  let clientDifficultyStatisticsService: {
    getMaximaForAddress: jest.Mock;
  };
  let difficultyScoresCacheService: {
    getDifficultyScores: jest.Mock;
  };
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    clientDifficultyStatisticsService = {
      getMaximaForAddress: jest.fn().mockResolvedValue([]),
    };
    difficultyScoresCacheService = {
      getDifficultyScores: jest.fn().mockResolvedValue({ slotData: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientController],
      providers: [
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: REDIS_CLIENT, useValue: null },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ClientService, useValue: {} },
        { provide: ClientStatisticsService, useValue: {} },
        { provide: AddressSettingsService, useValue: {} },
        { provide: ClientRejectedStatisticsService, useValue: {} },
        { provide: ClientDifficultyStatisticsService, useValue: clientDifficultyStatisticsService },
        { provide: StratumV1Service, useValue: {} },
        { provide: StratumV2Service, useValue: {} },
        { provide: ShareTotalsCacheService, useValue: {} },
        { provide: DifficultyScoresCacheService, useValue: difficultyScoresCacheService },
        { provide: BestDifficultyTrackerService, useValue: {} },
        { provide: WorkerSharesService, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    dateNowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2023, 0, 31, 12, 34, 0, 0));
  });

  afterEach(async () => {
    dateNowSpy.mockRestore();
    await app.close();
  });

  it('returns hourly difficulty maxima for the requested range', async () => {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    const hours = 7 * 24;
    const startSlot = Math.floor((now - hours * oneHour) / oneHour) * oneHour;
    const endSlot = Math.floor(now / oneHour) * oneHour;

    difficultyScoresCacheService.getDifficultyScores.mockResolvedValue({
      slotData: [
        { time: new Date(startSlot).toISOString(), difficulty: 42 },
        { time: new Date(startSlot + oneHour).toISOString(), difficulty: 0 },
        { time: new Date(startSlot + 2 * oneHour).toISOString(), difficulty: 99 },
        { time: new Date(endSlot).toISOString(), difficulty: 0 },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/diff-scores?range=7d',
    });

    expect(res.statusCode).toBe(200);

    expect(difficultyScoresCacheService.getDifficultyScores).toHaveBeenCalledWith(
      'addr123',
      '7d',
      startSlot,
      endSlot,
    );

    const payload = JSON.parse(res.payload);
    expect(payload.slotData[0]).toEqual({
      time: new Date(startSlot).toISOString(),
      difficulty: 42,
    });
    expect(payload.slotData[1]).toEqual({
      time: new Date(startSlot + oneHour).toISOString(),
      difficulty: 0,
    });
    expect(payload.slotData[2]).toEqual({
      time: new Date(startSlot + 2 * oneHour).toISOString(),
      difficulty: 99,
    });
    expect(payload.slotData[payload.slotData.length - 1]).toEqual({
      time: new Date(endSlot).toISOString(),
      difficulty: 0,
    });
  });

  it('defaults to returning one day of data when no range is specified', async () => {
    difficultyScoresCacheService.getDifficultyScores.mockResolvedValue({
      slotData: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/diff-scores',
    });

    expect(res.statusCode).toBe(200);

    const call =
      difficultyScoresCacheService.getDifficultyScores.mock.calls[
        difficultyScoresCacheService.getDifficultyScores.mock.calls.length - 1
      ];
    const [address, range, start, end] = call;
    expect(address).toBe('addr123');
    expect(range).toBe('1d');
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    const expectedStart = Math.floor((now - 24 * oneHour) / oneHour) * oneHour;
    const expectedEnd = Math.floor(now / oneHour) * oneHour;
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);

    const payload = JSON.parse(res.payload);
    expect(Array.isArray(payload.slotData)).toBe(true);
  });
});
