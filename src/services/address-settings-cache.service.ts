import { Injectable } from '@nestjs/common';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';

export interface AddressBestDifficultySnapshot {
  bestDifficulty: number;
  bestDifficultyUserAgent: string | null;
}

@Injectable()
export class AddressSettingsCacheService {
  private readonly cache = new Map<string, AddressBestDifficultySnapshot>();

  constructor(
    private readonly addressSettingsService: AddressSettingsService,
  ) {}

  async getBestDifficulty(address: string): Promise<AddressBestDifficultySnapshot> {
    const cached = await this.ensure(address);
    return { ...cached };
  }

  async shouldUpdateBestDifficulty(
    address: string,
    candidateDifficulty: number,
  ): Promise<boolean> {
    const cached = await this.ensure(address);
    return candidateDifficulty > cached.bestDifficulty;
  }

  updateBestDifficulty(
    address: string,
    bestDifficulty: number,
    bestDifficultyUserAgent: string | null,
  ): void {
    this.cache.set(address, {
      bestDifficulty,
      bestDifficultyUserAgent,
    });
  }

  clear(address?: string): void {
    if (address) {
      this.cache.delete(address);
      return;
    }
    this.cache.clear();
  }

  private async ensure(address: string): Promise<AddressBestDifficultySnapshot> {
    let cached = this.cache.get(address);
    if (!cached) {
      const settings = await this.addressSettingsService.getSettings(
        address,
        true,
      );
      cached = {
        bestDifficulty: settings?.bestDifficulty ?? 0,
        bestDifficultyUserAgent: settings?.bestDifficultyUserAgent ?? null,
      };
      this.cache.set(address, cached);
    }
    return cached;
  }
}
