import { Test, TestingModule } from '@nestjs/testing';
import { ClientStatsAggregator } from './client-stats-aggregator.service';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { HashrateHistoryService } from './hashrate-history.service';

describe('ClientStatsAggregator', () => {
  let aggregator: ClientStatsAggregator;
  let statsService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientStatsAggregator,
        { provide: ClientService, useValue: {
            getByAddress: jest.fn().mockResolvedValue([{ clientName: 'worker1', bestDifficulty: 0, hashRate: 0 }]),
            getBestShareEver: jest.fn().mockResolvedValue(0),
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
        { provide: HashrateHistoryService, useValue: {
            record: jest.fn(),
            getAverage: jest.fn().mockReturnValue(0),
          }},
      ],
    }).compile();

    aggregator = module.get(ClientStatsAggregator);
    statsService = module.get<ClientStatisticsService>(ClientStatisticsService);
  });

  it('returns lastshare from ClientStatisticsService', async () => {
    const stats = await aggregator.getStats('addr');
    expect(stats.lastshare).toBe(123456);
    expect(statsService.getLastShareTime).toHaveBeenCalledWith('addr');
    expect(stats.worker[0].lastshare).toBe(234567);
    expect(statsService.getLastShareTime).toHaveBeenCalledWith('addr', 'worker1');
  });
});
