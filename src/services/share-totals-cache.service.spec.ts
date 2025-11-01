import { ConfigService } from '@nestjs/config';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';

describe('ShareTotalsCacheService', () => {
  let clientStatisticsService: {
    getTotalSharesForAddress: jest.Mock;
    getTotalSharesForWorkers: jest.Mock;
    getTotalSharesForWorker: jest.Mock;
  };
  let addressSettingsService: { addShares: jest.Mock };
  let configService: { get: jest.Mock };
  let service: ShareTotalsCacheService;

  beforeEach(() => {
    clientStatisticsService = {
      getTotalSharesForAddress: jest.fn().mockResolvedValue(100),
      getTotalSharesForWorkers: jest.fn().mockResolvedValue([
        { clientName: 'worker-1', total: 60 },
        { clientName: 'worker-2', total: 40 },
      ]),
      getTotalSharesForWorker: jest.fn().mockImplementation(
        async (_address: string, workerName: string) => {
          if (workerName === 'worker-1') {
            return 60;
          }
          if (workerName === 'worker-2') {
            return 40;
          }
          return 0;
        },
      ),
    };
    addressSettingsService = {
      addShares: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'SHARE_TOTALS_FLUSH_INTERVAL_MS') {
          return '0';
        }
        return undefined;
      }),
    };

    service = new ShareTotalsCacheService(
      clientStatisticsService as unknown as ClientStatisticsService,
      addressSettingsService as unknown as AddressSettingsService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('hydrates address totals and applies increments', async () => {
    const total = await service.getAddressTotal('addr1');
    expect(total).toBe(100);
    expect(clientStatisticsService.getTotalSharesForAddress).toHaveBeenCalledTimes(1);

    await service.increment('addr1', 'worker-1', 25);
    const updatedTotal = await service.getAddressTotal('addr1');
    expect(updatedTotal).toBe(125);
    expect(clientStatisticsService.getTotalSharesForAddress).toHaveBeenCalledTimes(1);
  });

  it('hydrates worker totals and adds new workers when incremented', async () => {
    const workerTotalsFirst = await service.getWorkerTotals('addr1');
    expect(workerTotalsFirst).toEqual([
      { workerName: 'worker-1', total: 60 },
      { workerName: 'worker-2', total: 40 },
    ]);
    expect(clientStatisticsService.getTotalSharesForWorkers).toHaveBeenCalledTimes(1);
    expect(clientStatisticsService.getTotalSharesForWorker).not.toHaveBeenCalled();

    const workerTotalsSecond = await service.getWorkerTotals('addr1');
    expect(workerTotalsSecond).toEqual([
      { workerName: 'worker-1', total: 60 },
      { workerName: 'worker-2', total: 40 },
    ]);
    expect(clientStatisticsService.getTotalSharesForWorkers).toHaveBeenCalledTimes(1);
  });

  it('hydrates individual worker baselines lazily when incrementing', async () => {
    clientStatisticsService.getTotalSharesForWorker.mockResolvedValue(5);
    clientStatisticsService.getTotalSharesForWorkers.mockResolvedValueOnce([
      { clientName: 'worker-1', total: 60 },
      { clientName: 'worker-2', total: 40 },
      { clientName: 'worker-3', total: 5 },
    ]);

    await service.increment('addr1', 'worker-3', 15);

    expect(clientStatisticsService.getTotalSharesForWorker).toHaveBeenCalledTimes(1);
    expect(clientStatisticsService.getTotalSharesForWorker).toHaveBeenCalledWith(
      'addr1',
      'worker-3',
    );
    expect(clientStatisticsService.getTotalSharesForWorkers).not.toHaveBeenCalled();

    const updated = await service.getWorkerTotals('addr1');
    const sorted = [...updated].sort((a, b) => a.workerName.localeCompare(b.workerName));
    expect(sorted).toEqual([
      { workerName: 'worker-1', total: 60 },
      { workerName: 'worker-2', total: 40 },
      { workerName: 'worker-3', total: 20 },
    ]);
    expect(clientStatisticsService.getTotalSharesForWorkers).toHaveBeenCalledTimes(1);
  });

  it('flushes deltas to durable storage and resets in-memory accumulators', async () => {
    await service.increment('addr1', 'worker-1', 30);
    await service.increment('addr1', 'worker-2', 10);

    await service.flush();

    expect(addressSettingsService.addShares).toHaveBeenCalledTimes(1);
    expect(addressSettingsService.addShares).toHaveBeenCalledWith('addr1', 40);

    const totals = await service.getWorkerTotals('addr1');
    const sorted = [...totals].sort((a, b) => a.workerName.localeCompare(b.workerName));
    expect(sorted).toEqual([
      { workerName: 'worker-1', total: 90 },
      { workerName: 'worker-2', total: 50 },
    ]);

    await service.flush();
    expect(addressSettingsService.addShares).toHaveBeenCalledTimes(1);
  });
});
