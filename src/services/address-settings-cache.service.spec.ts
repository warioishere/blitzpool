import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { AddressSettingsCacheService } from './address-settings-cache.service';

describe('AddressSettingsCacheService', () => {
  let addressSettingsService: { getSettings: jest.Mock; getBestDifficultyLight: jest.Mock };
  let service: AddressSettingsCacheService;

  beforeEach(() => {
    addressSettingsService = {
      getSettings: jest.fn(),
      getBestDifficultyLight: jest.fn().mockResolvedValue(null),
    };
    service = new AddressSettingsCacheService(
      addressSettingsService as unknown as AddressSettingsService,
      { store: {} } as any,
    );
  });

  it('hydrates from the underlying service on first access', async () => {
    addressSettingsService.getSettings.mockResolvedValue({
      bestDifficulty: 42,
      bestDifficultyUserAgent: 'ua',
    });

    const snapshot = await service.getBestDifficulty('addr');

    expect(snapshot).toEqual({ bestDifficulty: 42, bestDifficultyUserAgent: 'ua' });
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(1);
    expect(addressSettingsService.getSettings).toHaveBeenCalledWith('addr', true);
  });

  it('caches subsequent lookups in memory', async () => {
    addressSettingsService.getSettings.mockResolvedValueOnce({
      bestDifficulty: 10,
      bestDifficultyUserAgent: null,
    });

    await service.getBestDifficulty('addr');
    const second = await service.getBestDifficulty('addr');

    expect(second).toEqual({ bestDifficulty: 10, bestDifficultyUserAgent: null });
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(1);
  });

  it('reports whether a candidate exceeds the cached value', async () => {
    addressSettingsService.getSettings.mockResolvedValue({
      bestDifficulty: 15,
      bestDifficultyUserAgent: null,
    });

    await expect(service.shouldUpdateBestDifficulty('addr', 10)).resolves.toBe(false);
    await expect(service.shouldUpdateBestDifficulty('addr', 20)).resolves.toBe(true);
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(1);
  });

  it('updates the cache after persisting a new best difficulty', async () => {
    addressSettingsService.getSettings.mockResolvedValue({
      bestDifficulty: 5,
      bestDifficultyUserAgent: null,
    });

    await service.getBestDifficulty('addr');
    service.updateBestDifficulty('addr', 25, 'ua');

    const snapshot = await service.getBestDifficulty('addr');
    expect(snapshot).toEqual({ bestDifficulty: 25, bestDifficultyUserAgent: 'ua' });
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(1);
  });

  it('allows clearing individual entries or the whole cache', async () => {
    addressSettingsService.getSettings.mockResolvedValue({
      bestDifficulty: 5,
      bestDifficultyUserAgent: null,
    });

    await service.getBestDifficulty('addr');
    service.clear('addr');
    addressSettingsService.getSettings.mockResolvedValue({
      bestDifficulty: 7,
      bestDifficultyUserAgent: 'ua',
    });

    await service.getBestDifficulty('addr');
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(2);

    service.clear();
    await service.getBestDifficulty('addr2');
    expect(addressSettingsService.getSettings).toHaveBeenCalledTimes(3);
  });

  describe('Redis-backed path (single SET ... EX)', () => {
    function buildRedis(initialStore: Record<string, string> = {}) {
      const store = new Map<string, string>(Object.entries(initialStore));
      const get = jest.fn(async (k: string) => store.get(k) ?? null);
      const set = jest.fn(async (k: string, v: string, _opts?: any) => { store.set(k, v); });
      const del = jest.fn(async (k: string | string[]) => {
        const ks = Array.isArray(k) ? k : [k];
        for (const key of ks) store.delete(key);
      });
      const scan = jest.fn(async () => ({ cursor: '0', keys: [] }));
      return { redis: { get, set, del, scan, expire: jest.fn() }, store };
    }

    it('write uses a single SET … EX 3600 (no separate EXPIRE call)', async () => {
      const { redis } = buildRedis();
      const svc = new AddressSettingsCacheService(
        addressSettingsService as any,
        { store: { client: redis } } as any,
      );
      await svc.onModuleInit();
      await svc.updateBestDifficulty('addr-A', 42, 'ua');
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, opts] = redis.set.mock.calls[0];
      expect(key).toBe('addrSettings:v2:addr-A');
      expect(JSON.parse(value)).toEqual({ bestDifficulty: 42, bestDifficultyUserAgent: 'ua' });
      expect(opts).toEqual({ EX: 3600 });
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('read hits Redis with one GET; cache hit avoids hitting the underlying service', async () => {
      const seeded = JSON.stringify({ bestDifficulty: 99, bestDifficultyUserAgent: 'cached' });
      const { redis } = buildRedis({ 'addrSettings:v2:addr-A': seeded });
      const svc = new AddressSettingsCacheService(
        addressSettingsService as any,
        { store: { client: redis } } as any,
      );
      await svc.onModuleInit();

      const snap = await svc.getBestDifficulty('addr-A');
      expect(snap).toEqual({ bestDifficulty: 99, bestDifficultyUserAgent: 'cached' });
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(addressSettingsService.getSettings).not.toHaveBeenCalled();
    });

    it('cache miss falls through to the underlying service and stores the result', async () => {
      const { redis } = buildRedis();
      // Light returns the row → no need to hit the entity-path upsert.
      addressSettingsService.getBestDifficultyLight.mockResolvedValueOnce({
        bestDifficulty: 7,
        bestDifficultyUserAgent: 'ua',
      });
      const svc = new AddressSettingsCacheService(
        addressSettingsService as any,
        { store: { client: redis } } as any,
      );
      await svc.onModuleInit();

      const snap = await svc.getBestDifficulty('addr-B');
      expect(snap).toEqual({ bestDifficulty: 7, bestDifficultyUserAgent: 'ua' });
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, opts] = redis.set.mock.calls[0];
      expect(key).toBe('addrSettings:v2:addr-B');
      expect(JSON.parse(value)).toEqual({ bestDifficulty: 7, bestDifficultyUserAgent: 'ua' });
      expect(opts).toEqual({ EX: 3600 });
    });
  });
});
