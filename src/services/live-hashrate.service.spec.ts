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
    // 1h lookback at 60s buckets = 61 bucket keys (inclusive of both endpoints).
    const expectedPoolKeys1h = (() => {
      const start = ALIGNED_NOW - 3600 * 1000;
      const out: string[] = [];
      for (let ts = start; ts <= ALIGNED_NOW; ts += 60000) out.push(`livehash:pool:${ts}`);
      return out;
    })();

    it('uses mGet (batch) over deterministic bucket keys, not SCAN', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedPoolKeys1h.length).fill(null));

      await service.getPoolLiveHashrate(1);

      expect(mockRedis.scan).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
      expect(mockRedis.mGet).toHaveBeenCalledWith(expectedPoolKeys1h);
    });

    it('returns correct hashrate data points within the time window', async () => {
      const ts1 = ALIGNED_NOW - 60000;
      const ts2 = ALIGNED_NOW;
      const idx1 = expectedPoolKeys1h.indexOf(`livehash:pool:${ts1}`);
      const idx2 = expectedPoolKeys1h.indexOf(`livehash:pool:${ts2}`);
      const values: (string | null)[] = new Array(expectedPoolKeys1h.length).fill(null);
      values[idx1] = JSON.stringify({ hashrate: 1500 });
      values[idx2] = JSON.stringify({ hashrate: 2500 });
      mockRedis.mGet.mockResolvedValue(values);

      const result = await service.getPoolLiveHashrate(1);

      const point1 = result.find(p => p.label === new Date(ts1).toISOString());
      const point2 = result.find(p => p.label === new Date(ts2).toISOString());
      expect(point1?.data).toBe(1500);
      expect(point2?.data).toBe(2500);
    });

    it('only requests keys inside the requested time window', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedPoolKeys1h.length).fill(null));

      await service.getPoolLiveHashrate(1);

      const args = mockRedis.mGet.mock.calls[0][0] as string[];
      // Every requested key must be within [alignedStart, alignedNow]
      const alignedStart = ALIGNED_NOW - 3600 * 1000;
      for (const k of args) {
        const ts = parseInt(k.split(':').pop() as string, 10);
        expect(ts).toBeGreaterThanOrEqual(alignedStart);
        expect(ts).toBeLessThanOrEqual(ALIGNED_NOW);
      }
    });

    it('returns empty array when no buckets contain data (matches old SCAN behavior)', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedPoolKeys1h.length).fill(null));

      const result = await service.getPoolLiveHashrate(1);

      expect(result).toEqual([]);
    });
  });

  describe('getAddressLiveHashrate', () => {
    const ADDR = 'bc1qtest123';
    const expectedAddrKeys1h = (() => {
      const start = ALIGNED_NOW - 3600 * 1000;
      const out: string[] = [];
      for (let ts = start; ts <= ALIGNED_NOW; ts += 60000) out.push(`livehash:addr:${ADDR}:${ts}`);
      return out;
    })();

    it('uses mGet (batch) over deterministic bucket keys, not SCAN', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedAddrKeys1h.length).fill(null));

      await service.getAddressLiveHashrate(ADDR, 1);

      expect(mockRedis.scan).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
      expect(mockRedis.mGet).toHaveBeenCalledWith(expectedAddrKeys1h);
    });

    it('returns correct data points for the address', async () => {
      const ts = ALIGNED_NOW - 60000;
      const idx = expectedAddrKeys1h.indexOf(`livehash:addr:${ADDR}:${ts}`);
      const values: (string | null)[] = new Array(expectedAddrKeys1h.length).fill(null);
      values[idx] = JSON.stringify({ hashrate: 500 });
      mockRedis.mGet.mockResolvedValue(values);

      const result = await service.getAddressLiveHashrate(ADDR, 1);

      const point = result.find(p => p.label === new Date(ts).toISOString());
      expect(point?.data).toBe(500);
    });

    it('only requests keys inside the requested time window', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedAddrKeys1h.length).fill(null));

      await service.getAddressLiveHashrate(ADDR, 1);

      const args = mockRedis.mGet.mock.calls[0][0] as string[];
      const alignedStart = ALIGNED_NOW - 3600 * 1000;
      for (const k of args) {
        const ts = parseInt(k.split(':').pop() as string, 10);
        expect(ts).toBeGreaterThanOrEqual(alignedStart);
        expect(ts).toBeLessThanOrEqual(ALIGNED_NOW);
      }
    });

    it('returns empty array when no buckets contain data (matches old SCAN behavior)', async () => {
      mockRedis.mGet.mockResolvedValue(new Array(expectedAddrKeys1h.length).fill(null));

      const result = await service.getAddressLiveHashrate(ADDR, 1);

      expect(result).toEqual([]);
    });
  });
});
