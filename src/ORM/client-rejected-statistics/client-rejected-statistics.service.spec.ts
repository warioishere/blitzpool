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
});
