import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';

describe('ShareTotalsCacheService', () => {
  let clientStatisticsService: {
    getTotalSharesForAddress: jest.Mock;
    getTotalSharesForWorkers: jest.Mock;
  };
  let addressSettingsService: {
    getSettings: jest.Mock;
  };
  let workerSharesService: {
    getWorkerTotals: jest.Mock;
  };
  let cacheManager: any;
  let service: ShareTotalsCacheService;

  beforeEach(() => {
    clientStatisticsService = {
      getTotalSharesForAddress: jest.fn().mockResolvedValue(100),
      getTotalSharesForWorkers: jest.fn().mockResolvedValue([
        { clientName: 'worker-1', total: 60 },
        { clientName: 'worker-2', total: 40 },
      ]),
    };

    addressSettingsService = {
      getSettings: jest.fn().mockResolvedValue({ shares: 100 }),
    };

    workerSharesService = {
      getWorkerTotals: jest.fn().mockResolvedValue([
        { clientName: 'worker-1', shares: 60 },
        { clientName: 'worker-2', shares: 40 },
      ]),
    };

    // Mock cache manager without Redis (fallback mode)
    cacheManager = {
      store: {},
    };

    service = new ShareTotalsCacheService(
      cacheManager,
      clientStatisticsService as unknown as ClientStatisticsService,
      addressSettingsService as unknown as AddressSettingsService,
      workerSharesService as unknown as WorkerSharesService,
    );
  });

  describe('without Redis (fallback mode)', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('falls back to address_settings when Redis is not available', async () => {
      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(100);
      expect(addressSettingsService.getSettings).toHaveBeenCalledWith('addr1', false);
    });

    it('returns worker totals from worker_shares_entity when Redis is not available', async () => {
      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([
        { workerName: 'worker-1', total: 60 },
        { workerName: 'worker-2', total: 40 },
      ]);
      expect(workerSharesService.getWorkerTotals).toHaveBeenCalledWith('addr1');
    });

    it('silently skips increment when Redis is not available', () => {
      // Should not throw
      service.increment('addr1', 'worker-1', 25);
      expect(true).toBe(true);
    });
  });

  describe('with Redis', () => {
    let mockRedisClient: any;

    beforeEach(async () => {
      mockRedisClient = {
        hIncrByFloat: jest.fn().mockResolvedValue(undefined),
        hGetAll: jest.fn().mockResolvedValue({}),
        hSet: jest.fn().mockResolvedValue(undefined),
        scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
        del: jest.fn().mockResolvedValue(undefined),
      };

      cacheManager = {
        store: {
          client: mockRedisClient,
        },
      };

      service = new ShareTotalsCacheService(
        cacheManager,
        clientStatisticsService as unknown as ClientStatisticsService,
        addressSettingsService as unknown as AddressSettingsService,
        workerSharesService as unknown as WorkerSharesService,
      );

      await service.onModuleInit();
    });

    it('increments address total atomically in Redis', () => {
      service.increment('addr1', undefined, 25);

      expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(
        'shares:address:addr1',
        'delta',
        25,
      );
    });

    it('increments worker total atomically in Redis', () => {
      service.increment('addr1', 'worker-1', 25);

      expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(
        'shares:address:addr1',
        'delta',
        25,
      );
      expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(
        'shares:worker:addr1:worker-1',
        'delta',
        25,
      );
    });

    it('returns total from Redis baseline + delta', async () => {
      mockRedisClient.hGetAll.mockResolvedValue({
        baseline: '100',
        delta: '25',
      });

      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(125);
      expect(mockRedisClient.hGetAll).toHaveBeenCalledWith('shares:address:addr1');
    });

    it('returns 0 when address not found in Redis and database is empty', async () => {
      mockRedisClient.hGetAll.mockResolvedValue({});
      addressSettingsService.getSettings.mockResolvedValueOnce(null);

      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(0);
    });

    it('returns worker totals from DB + unflushed Redis deltas', async () => {
      mockRedisClient.scan.mockResolvedValueOnce({
        cursor: 0,
        keys: ['shares:worker:addr1:worker-1', 'shares:worker:addr1:worker-2'],
      });

      mockRedisClient.hGetAll
        .mockResolvedValueOnce({ delta: '5' })
        .mockResolvedValueOnce({ delta: '10' });

      const workerTotals = await service.getWorkerTotals('addr1');
      // DB has worker-1=60, worker-2=40 + Redis deltas 5, 10
      expect(workerTotals).toEqual(expect.arrayContaining([
        { workerName: 'worker-1', total: 65 },
        { workerName: 'worker-2', total: 50 },
      ]));
    });

    it('uses SCAN instead of KEYS to find worker keys', async () => {
      mockRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });

      await service.getWorkerTotals('addr1');

      expect(mockRedisClient.scan).toHaveBeenCalledWith('0', {
        MATCH: 'shares:worker:addr1:*',
        COUNT: 100,
      });
      expect(mockRedisClient).not.toHaveProperty('keys');
    });

    it('returns empty array when no workers in DB and no Redis deltas', async () => {
      mockRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });
      workerSharesService.getWorkerTotals.mockResolvedValueOnce([]);

      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([]);
    });

    it('filters out hydration markers and lock keys from Redis', async () => {
      mockRedisClient.scan.mockResolvedValueOnce({
        cursor: 0,
        keys: [
          'shares:worker:addr1:worker-1',
          'shares:worker:addr1:worker-2:hydrated',
          'shares:worker:addr1:worker-3:lock',
        ],
      });

      mockRedisClient.hGetAll.mockResolvedValueOnce({ delta: '5' });

      const workerTotals = await service.getWorkerTotals('addr1');
      // DB has worker-1=60 + delta 5 = 65, worker-2=40 (no delta)
      expect(workerTotals).toEqual(expect.arrayContaining([
        { workerName: 'worker-1', total: 65 },
        { workerName: 'worker-2', total: 40 },
      ]));
    });

    it('skips increment when difficulty is invalid', () => {
      service.increment('addr1', 'worker-1', 0);
      service.increment('addr1', 'worker-1', -5);
      service.increment('addr1', 'worker-1', NaN);

      expect(mockRedisClient.hIncrByFloat).not.toHaveBeenCalled();
    });

    it('skips increment when address is empty', () => {
      service.increment('', 'worker-1', 25);

      expect(mockRedisClient.hIncrByFloat).not.toHaveBeenCalled();
    });
  });
});
