import { ClientRejectedStatisticsService } from './client-rejected-statistics.service';

describe('ClientRejectedStatisticsService', () => {
  let mockRedisClient: any;
  let cacheManager: any;
  let service: ClientRejectedStatisticsService;

  beforeEach(async () => {
    mockRedisClient = {
      hIncrBy: jest.fn().mockResolvedValue(undefined),
      hIncrByFloat: jest.fn().mockResolvedValue(undefined),
      expire: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(undefined),
    };

    cacheManager = {
      store: {
        client: mockRedisClient,
      },
    };

    service = new ClientRejectedStatisticsService({} as any, cacheManager as any);
    await service.onModuleInit();
  });

  it('atomically increments count and shares in Redis', async () => {
    const tenMinutes = 1000 * 60 * 10;
    const now = 1700000000000;
    const timeSlot = Math.floor(now / tenMinutes) * tenMinutes + tenMinutes;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      await service.addRejectedShare('addr', 'duplicate', 5);

      const expectedKey = `client:rejected:addr:${timeSlot}`;
      expect(mockRedisClient.hIncrBy).toHaveBeenCalledWith(expectedKey, 'duplicate:count', 1);
      expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(expectedKey, 'duplicate:shares', 4);
      expect(mockRedisClient.expire).toHaveBeenCalledWith(expectedKey, 86400);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sends all Redis commands in parallel via Promise.all', async () => {
    const callOrder: string[] = [];
    mockRedisClient.hIncrBy.mockImplementation(() => { callOrder.push('hIncrBy'); return Promise.resolve(); });
    mockRedisClient.hIncrByFloat.mockImplementation(() => { callOrder.push('hIncrByFloat'); return Promise.resolve(); });
    mockRedisClient.expire.mockImplementation(() => { callOrder.push('expire'); return Promise.resolve(); });

    await service.addRejectedShare('addr', 'duplicate', 5);

    // All three should have been called (order doesn't matter with Promise.all)
    expect(callOrder).toHaveLength(3);
    expect(callOrder).toContain('hIncrBy');
    expect(callOrder).toContain('hIncrByFloat');
    expect(callOrder).toContain('expire');
  });

  it('does not track when Redis is not available', async () => {
    const serviceNoRedis = new ClientRejectedStatisticsService({} as any, { store: {} } as any);
    await serviceNoRedis.onModuleInit();

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await serviceNoRedis.addRejectedShare('addr', 'duplicate', 5);
      expect(mockRedisClient.hIncrBy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  describe('clearRedisKeysForAddress', () => {
    it('uses SCAN instead of KEYS to find matching keys', async () => {
      mockRedisClient.scan = jest.fn()
        .mockResolvedValueOnce({ cursor: '5', keys: ['client:rejected:addr:100', 'client:rejected:addr:200'] })
        .mockResolvedValueOnce({ cursor: '0', keys: ['client:rejected:addr:300'] });

      await service.clearRedisKeysForAddress('addr');

      expect(mockRedisClient.scan).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.scan).toHaveBeenCalledWith('0', { MATCH: 'client:rejected:addr:*', COUNT: 1000 });
      expect(mockRedisClient.scan).toHaveBeenCalledWith('5', { MATCH: 'client:rejected:addr:*', COUNT: 1000 });
      expect(mockRedisClient.del).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.del).toHaveBeenCalledWith(['client:rejected:addr:100', 'client:rejected:addr:200']);
      expect(mockRedisClient.del).toHaveBeenCalledWith(['client:rejected:addr:300']);
    });

    it('handles no matching keys gracefully', async () => {
      mockRedisClient.scan = jest.fn()
        .mockResolvedValueOnce({ cursor: '0', keys: [] });

      await service.clearRedisKeysForAddress('addr');

      expect(mockRedisClient.scan).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });
});
