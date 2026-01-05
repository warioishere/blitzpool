import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';

describe('ShareTotalsCacheService', () => {
  let clientStatisticsService: {
    getTotalSharesForAddress: jest.Mock;
    getTotalSharesForWorkers: jest.Mock;
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

    // Mock cache manager without Redis (fallback mode)
    cacheManager = {
      store: {},
    };

    service = new ShareTotalsCacheService(
      cacheManager,
      clientStatisticsService as unknown as ClientStatisticsService,
    );
  });

  describe('without Redis (fallback mode)', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('falls back to database queries when Redis is not available', async () => {
      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(100);
      expect(clientStatisticsService.getTotalSharesForAddress).toHaveBeenCalledWith('addr1');
    });

    it('returns worker totals from database when Redis is not available', async () => {
      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([
        { workerName: 'worker-1', total: 60 },
        { workerName: 'worker-2', total: 40 },
      ]);
      expect(clientStatisticsService.getTotalSharesForWorkers).toHaveBeenCalledWith('addr1');
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
        keys: jest.fn().mockResolvedValue([]),
      };

      cacheManager = {
        store: {
          client: mockRedisClient,
        },
      };

      service = new ShareTotalsCacheService(
        cacheManager,
        clientStatisticsService as unknown as ClientStatisticsService,
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

    it('returns 0 when address not found in Redis', async () => {
      mockRedisClient.hGetAll.mockResolvedValue({});

      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(0);
    });

    it('returns worker totals from Redis', async () => {
      mockRedisClient.keys.mockResolvedValue([
        'shares:worker:addr1:worker-1',
        'shares:worker:addr1:worker-2',
      ]);

      mockRedisClient.hGetAll
        .mockResolvedValueOnce({ baseline: '60', delta: '5' })
        .mockResolvedValueOnce({ baseline: '40', delta: '10' });

      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([
        { workerName: 'worker-1', total: 65 },
        { workerName: 'worker-2', total: 50 },
      ]);
    });

    it('returns empty array when no workers found in Redis', async () => {
      mockRedisClient.keys.mockResolvedValue([]);

      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([]);
    });

    it('filters out hydration markers and lock keys', async () => {
      mockRedisClient.keys.mockResolvedValue([
        'shares:worker:addr1:worker-1',
        'shares:worker:addr1:worker-2:hydrated',
        'shares:worker:addr1:worker-3:lock',
      ]);

      mockRedisClient.hGetAll.mockResolvedValueOnce({ baseline: '60', delta: '5' });

      const workerTotals = await service.getWorkerTotals('addr1');
      expect(workerTotals).toEqual([
        { workerName: 'worker-1', total: 65 },
      ]);
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
