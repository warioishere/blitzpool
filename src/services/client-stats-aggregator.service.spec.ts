import { Test, TestingModule } from '@nestjs/testing';
import { ClientStatsAggregator } from './client-stats-aggregator.service';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';

describe('ClientStatsAggregator', () => {
  let aggregator: ClientStatsAggregator;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientStatsAggregator,
        { provide: ClientService, useValue: {
            getByAddress: jest.fn().mockResolvedValue([{ clientName: 'worker1', bestDifficulty: 0, hashRate: 0 }]),
            getBestShareEver: jest.fn().mockResolvedValue(0),
            getLastShareDiff: jest.fn().mockResolvedValue(42),
          }},
        { provide: ClientStatisticsService, useValue: {
            getTotalSharesForAddress: jest.fn().mockResolvedValue(0),
            getHashRate: jest.fn().mockResolvedValue(0),
            getTotalSharesForWorkers: jest.fn().mockResolvedValue([]),
            getTotalsByWorkerSince: jest.fn(), // not used
            getLastShareTime: jest.fn((address: string, clientName?: string) =>
              Promise.resolve(clientName ? 234567 : 123456)),
          }},
        { provide: AddressSettingsService, useValue: { getSettings: jest.fn().mockResolvedValue({}) }},
        { provide: ClientRejectedStatisticsService, useValue: {
            getTotalsSince: jest.fn().mockResolvedValue({}),
            getTotalsByWorkerSince: jest.fn().mockResolvedValue({}),
          }},
      ],
    }).compile();

    aggregator = module.get(ClientStatsAggregator);
  });

  it('returns worker lastshare from ClientService', async () => {
    const stats = await aggregator.getStats('addr');
    expect(stats.worker[0].lastshare).toBe(42);
  });
});
