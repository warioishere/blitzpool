import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { AddressSettingsCacheService } from './address-settings-cache.service';

describe('AddressSettingsCacheService', () => {
  let addressSettingsService: { getSettings: jest.Mock };
  let service: AddressSettingsCacheService;

  beforeEach(() => {
    addressSettingsService = {
      getSettings: jest.fn(),
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
});
