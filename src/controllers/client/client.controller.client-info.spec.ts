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
import { StratumV1Service } from '../../services/stratum-v1.service';
import { StratumV2Service } from '../../services/stratum-v2.service';
import { ShareTotalsCacheService } from '../../services/share-totals-cache.service';
import { DifficultyScoresCacheService } from '../../services/difficulty-scores-cache.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { WorkerSharesService } from '../../ORM/worker-shares/worker-shares.service';

describe('ClientController getClientInfo', () => {
  let app: NestFastifyApplication;
  let clientService: { getByAddressLight: jest.Mock };
  let clientStatisticsService: { getTotalSharesForAddress: jest.Mock };
  let addressSettingsService: { getSettings: jest.Mock };
  let stratumV1Service: { getCurrentDifficulties: jest.Mock };
  let stratumV2Service: { getCurrentDifficulties: jest.Mock };
  let shareTotalsCacheService: { getAddressTotal: jest.Mock };

  beforeEach(async () => {
    clientService = {
      getByAddressLight: jest.fn().mockResolvedValue([
        {
          sessionId: 'session-1',
          clientName: 'worker-1',
          bestDifficulty: 12.3456,
          hashRate: 100,
          startTime: new Date('2023-01-01T00:00:00.000Z'),
          updatedAt: new Date('2023-01-01T01:00:00.000Z'),
          currentDifficulty: null,
        },
        {
          sessionId: null,
          clientName: 'worker-2',
          bestDifficulty: 1,
          hashRate: null,
          startTime: new Date('2023-01-02T00:00:00.000Z'),
          updatedAt: new Date('2023-01-02T01:00:00.000Z'),
          currentDifficulty: 4096,
        },
      ]),
    };
    clientStatisticsService = {
      getTotalSharesForAddress: jest.fn().mockResolvedValue(12345),
    };
    addressSettingsService = {
      getSettings: jest.fn().mockResolvedValue({ bestDifficulty: 98765 }),
    };
    stratumV1Service = {
      getCurrentDifficulties: jest
        .fn()
        .mockReturnValue(new Map([['session-1', 2048]])),
    };
    stratumV2Service = {
      getCurrentDifficulties: jest.fn().mockReturnValue(new Map()),
    };
    shareTotalsCacheService = {
      getAddressTotal: jest.fn().mockResolvedValue(12345),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientController],
      providers: [
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ClientService, useValue: clientService },
        { provide: ClientStatisticsService, useValue: clientStatisticsService },
        { provide: AddressSettingsService, useValue: addressSettingsService },
        { provide: ClientRejectedStatisticsService, useValue: {} },
        { provide: ClientDifficultyStatisticsService, useValue: {} },
        { provide: StratumV1Service, useValue: stratumV1Service },
        { provide: StratumV2Service, useValue: stratumV2Service },
        { provide: ShareTotalsCacheService, useValue: shareTotalsCacheService },
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

  it('returns workers including current difficulty when available', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/btc123',
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);

    expect(payload).toEqual({
      bestDifficulty: 98765,
      workersCount: 2,
      totalShares: 12345,
      totalHashrate: 100,
      workers: [
        {
          sessionId: 'session-1',
          name: 'worker-1',
          bestDifficulty: '12.35',
          hashRate: 100,
          currentDifficulty: 2048,
          startTime: '2023-01-01T00:00:00.000Z',
          lastSeen: '2023-01-01T01:00:00.000Z',
        },
        {
          sessionId: null,
          name: 'worker-2',
          bestDifficulty: '1.00',
          hashRate: null,
          currentDifficulty: 4096,
          startTime: '2023-01-02T00:00:00.000Z',
          lastSeen: '2023-01-02T01:00:00.000Z',
        },
      ],
    });
    expect(clientService.getByAddressLight).toHaveBeenCalledWith('btc123');
    expect(stratumV1Service.getCurrentDifficulties).toHaveBeenCalledWith(
      'btc123',
    );
    expect(shareTotalsCacheService.getAddressTotal).toHaveBeenCalledWith('btc123');
  });
});
