import { PoolShareStatisticsService } from './pool-share-statistics.service';

describe('PoolShareStatisticsService', () => {
  let mockRedisClient: any;
  let cacheManager: any;
  let service: PoolShareStatisticsService;

  beforeEach(async () => {
    mockRedisClient = {
      hIncrByFloat: jest.fn().mockResolvedValue(undefined),
      expire: jest.fn().mockResolvedValue(undefined),
    };

    cacheManager = {
      store: {
        client: mockRedisClient,
      },
    };

    service = new PoolShareStatisticsService({} as any, cacheManager as any);
    await service.onModuleInit();
  });

  it('atomically increments accepted shares in Redis', async () => {
    await service.addAcceptedShare(3);

    expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(
      expect.stringMatching(/^pool:shares:\d+$/),
      'accepted',
      3,
    );
    expect(mockRedisClient.expire).toHaveBeenCalledWith(
      expect.stringMatching(/^pool:shares:\d+$/),
      expect.any(Number),
    );
  });

  it('atomically increments rejected shares in Redis', async () => {
    await service.addRejectedShare(2);

    expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledWith(
      expect.stringMatching(/^pool:shares:\d+$/),
      'rejected',
      2,
    );
  });

  it('sends hIncrByFloat and expire in parallel via Promise.all', async () => {
    const callOrder: string[] = [];
    mockRedisClient.hIncrByFloat.mockImplementation(() => { callOrder.push('hIncrByFloat'); return Promise.resolve(); });
    mockRedisClient.expire.mockImplementation(() => { callOrder.push('expire'); return Promise.resolve(); });

    await service.addAcceptedShare(5);

    // Both should be called (hIncrByFloat + expire)
    expect(callOrder).toContain('hIncrByFloat');
    expect(callOrder).toContain('expire');
    expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.expire).toHaveBeenCalledTimes(1);
  });

  it('batches both accepted and rejected increments with expire', async () => {
    await (service as any).handleShare(3, 2);

    // 2x hIncrByFloat (accepted + rejected) + 1x expire
    expect(mockRedisClient.hIncrByFloat).toHaveBeenCalledTimes(2);
    expect(mockRedisClient.expire).toHaveBeenCalledTimes(1);
  });

  it('does not track when Redis is not available', async () => {
    const serviceNoRedis = new PoolShareStatisticsService({} as any, { store: {} } as any);
    await serviceNoRedis.onModuleInit();

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await serviceNoRedis.addAcceptedShare(3);
      expect(mockRedisClient.hIncrByFloat).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('discards non-finite share values', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    try {
      await service.addAcceptedShare(NaN);
      expect(mockRedisClient.hIncrByFloat).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
