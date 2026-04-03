import { LiveHashrateService } from './live-hashrate.service';
import { ConfigService } from '@nestjs/config';

jest.mock('node-telegram-bot-api', () => ({}));

describe('LiveHashrateService', () => {
  let service: LiveHashrateService;
  let mockRedis: any;
  let dateNowSpy: jest.SpyInstance;

  const FIXED_NOW = Date.UTC(2024, 0, 1, 12, 5, 30, 0); // 2024-01-01 12:05:30 UTC
  // alignedNow = floor(12:05:30 / 60s) * 60s - 60s = 12:04:00
  const ALIGNED_NOW = Math.floor(FIXED_NOW / 60000) * 60000 - 60000;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    mockRedis = {
      scan: jest.fn(),
      get: jest.fn(), // should NOT be called — we use mGet now
      mGet: jest.fn().mockResolvedValue([]),
      setEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      multi: jest.fn().mockReturnValue({
        setEx: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };

    const configService = {
      get: jest.fn().mockReturnValue(undefined), // No REDIS_HOST → skip Redis init
    } as unknown as ConfigService;

    const v1 = {
      getAllAddresses: jest.fn().mockReturnValue([]),
      getClientsForAddress: jest.fn().mockReturnValue([]),
    } as any;

    const v2 = {
      getAllAddresses: jest.fn().mockReturnValue([]),
      getClientsForAddress: jest.fn().mockReturnValue([]),
    } as any;

    service = new LiveHashrateService(v1, v2, configService);
    // Inject redis directly instead of going through onModuleInit
    (service as any).redis = mockRedis;
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  function setupScan(keys: string[]) {
    mockRedis.scan.mockResolvedValueOnce({ cursor: 0, keys });
  }

  describe('scanKeys', () => {
    it('uses COUNT 1000 to reduce Redis round-trips', async () => {
      mockRedis.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });

      await (service as any).scanKeys('livehash:pool:*');

      expect(mockRedis.scan).toHaveBeenCalledWith(0, {
        MATCH: 'livehash:pool:*',
        COUNT: 1000,
      });
    });

    it('iterates cursors until done', async () => {
      mockRedis.scan
        .mockResolvedValueOnce({ cursor: 42, keys: ['key1'] })
        .mockResolvedValueOnce({ cursor: 0, keys: ['key2'] });

      const keys = await (service as any).scanKeys('*');

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(keys).toEqual(['key1', 'key2']);
    });
  });

  describe('getPoolLiveHashrate', () => {
    it('uses mGet (batch) instead of sequential get calls', async () => {
      const ts1 = ALIGNED_NOW - 60000;
      const ts2 = ALIGNED_NOW;

      setupScan([`livehash:pool:${ts1}`, `livehash:pool:${ts2}`]);
      mockRedis.mGet.mockResolvedValue([
        JSON.stringify({ hashrate: 1000 }),
        JSON.stringify({ hashrate: 2000 }),
      ]);

      await service.getPoolLiveHashrate(1);

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
      expect(mockRedis.mGet).toHaveBeenCalledWith([
        `livehash:pool:${ts1}`,
        `livehash:pool:${ts2}`,
      ]);
    });

    it('returns correct hashrate data points within the time window', async () => {
      const ts1 = ALIGNED_NOW - 60000;
      const ts2 = ALIGNED_NOW;

      setupScan([`livehash:pool:${ts1}`, `livehash:pool:${ts2}`]);
      mockRedis.mGet.mockResolvedValue([
        JSON.stringify({ hashrate: 1500 }),
        JSON.stringify({ hashrate: 2500 }),
      ]);

      const result = await service.getPoolLiveHashrate(1);

      const point1 = result.find(p => p.label === new Date(ts1).toISOString());
      const point2 = result.find(p => p.label === new Date(ts2).toISOString());
      expect(point1?.data).toBe(1500);
      expect(point2?.data).toBe(2500);
    });

    it('filters out keys outside the requested time window', async () => {
      const inside = ALIGNED_NOW - 30 * 60000;          // 30 min ago — inside 1h window
      const outside = ALIGNED_NOW - 3 * 3600 * 1000;   // 3 hours ago — outside 1h window

      setupScan([`livehash:pool:${inside}`, `livehash:pool:${outside}`]);
      mockRedis.mGet.mockResolvedValue([JSON.stringify({ hashrate: 999 })]);

      await service.getPoolLiveHashrate(1);

      // mGet should only receive the key within the window
      expect(mockRedis.mGet).toHaveBeenCalledWith([`livehash:pool:${inside}`]);
    });

    it('skips mGet entirely when no keys are in range', async () => {
      const outside = ALIGNED_NOW - 5 * 3600 * 1000;
      setupScan([`livehash:pool:${outside}`]);

      await service.getPoolLiveHashrate(1);

      expect(mockRedis.mGet).not.toHaveBeenCalled();
    });

    it('returns empty array when scan finds no keys', async () => {
      setupScan([]);

      const result = await service.getPoolLiveHashrate(1);

      expect(result).toEqual([]);
      expect(mockRedis.mGet).not.toHaveBeenCalled();
    });
  });

  describe('getAddressLiveHashrate', () => {
    const ADDR = 'bc1qtest123';

    it('uses mGet (batch) instead of sequential get calls', async () => {
      const ts1 = ALIGNED_NOW - 60000;
      const ts2 = ALIGNED_NOW;

      setupScan([
        `livehash:addr:${ADDR}:${ts1}`,
        `livehash:addr:${ADDR}:${ts2}`,
      ]);
      mockRedis.mGet.mockResolvedValue([
        JSON.stringify({ hashrate: 100 }),
        JSON.stringify({ hashrate: 200 }),
      ]);

      await service.getAddressLiveHashrate(ADDR, 1);

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
      expect(mockRedis.mGet).toHaveBeenCalledWith([
        `livehash:addr:${ADDR}:${ts1}`,
        `livehash:addr:${ADDR}:${ts2}`,
      ]);
    });

    it('returns correct data points for the address', async () => {
      const ts = ALIGNED_NOW - 60000;

      setupScan([`livehash:addr:${ADDR}:${ts}`]);
      mockRedis.mGet.mockResolvedValue([JSON.stringify({ hashrate: 500 })]);

      const result = await service.getAddressLiveHashrate(ADDR, 1);

      const point = result.find(p => p.label === new Date(ts).toISOString());
      expect(point?.data).toBe(500);
    });

    it('filters out keys outside the time window', async () => {
      const inside = ALIGNED_NOW - 30 * 60000;
      const outside = ALIGNED_NOW - 5 * 3600 * 1000;

      setupScan([
        `livehash:addr:${ADDR}:${inside}`,
        `livehash:addr:${ADDR}:${outside}`,
      ]);
      mockRedis.mGet.mockResolvedValue([JSON.stringify({ hashrate: 777 })]);

      await service.getAddressLiveHashrate(ADDR, 1);

      expect(mockRedis.mGet).toHaveBeenCalledWith([`livehash:addr:${ADDR}:${inside}`]);
    });

    it('returns empty array when no keys found', async () => {
      setupScan([]);

      const result = await service.getAddressLiveHashrate(ADDR, 1);

      expect(result).toEqual([]);
    });
  });
});
