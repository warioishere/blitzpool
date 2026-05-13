import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';

export interface AddressBestDifficultySnapshot {
  bestDifficulty: number;
  bestDifficultyUserAgent: string | null;
}

@Injectable()
export class AddressSettingsCacheService implements OnModuleInit {
  private redisClient: any = null;
  private useRedis: boolean = false;

  // Fallback in-memory cache
  private readonly cache = new Map<string, AddressBestDifficultySnapshot>();

  constructor(
    private readonly addressSettingsService: AddressSettingsService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
        console.log('[AddressSettingsCacheService] Using Redis cache');
      } else {
        console.log('[AddressSettingsCacheService] Redis not available, using in-memory cache');
      }
    } catch (error) {
      console.warn('[AddressSettingsCacheService] Failed to access Redis client, using in-memory cache:', error);
    }
  }

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

  /**
   * Key prefix bumped from `address:settings:` (HASH) to `addrSettings:v2:`
   * (JSON string with built-in TTL) so the write path can use a single
   * `SET ... EX 3600` instead of `HSET + EXPIRE`. Old HASH keys orphan
   * for ≤1 h and then self-expire.
   */
  private redisKey(address: string): string {
    return `addrSettings:v2:${address}`;
  }

  async updateBestDifficulty(
    address: string,
    bestDifficulty: number,
    bestDifficultyUserAgent: string | null,
  ): Promise<void> {
    if (this.useRedis && this.redisClient) {
      const payload = JSON.stringify({
        bestDifficulty,
        bestDifficultyUserAgent: bestDifficultyUserAgent ?? null,
      });
      await this.redisClient.set(this.redisKey(address), payload, { EX: 3600 });
    } else {
      // Fallback in-memory implementation
      this.cache.set(address, {
        bestDifficulty,
        bestDifficultyUserAgent,
      });
    }
  }

  async clear(address?: string): Promise<void> {
    if (this.useRedis && this.redisClient) {
      if (address) {
        await this.redisClient.del(this.redisKey(address));
      } else {
        const pattern = 'addrSettings:v2:*';
        let cursor = '0';
        do {
          const result = await this.redisClient.scan(cursor, { MATCH: pattern, COUNT: 1000 });
          cursor = result.cursor.toString();
          if (result.keys.length > 0) {
            await this.redisClient.del(result.keys);
          }
        } while (cursor !== '0');
      }
    } else {
      if (address) {
        this.cache.delete(address);
        return;
      }
      this.cache.clear();
    }
  }

  private async ensure(address: string): Promise<AddressBestDifficultySnapshot> {
    if (this.useRedis && this.redisClient) {
      const key = this.redisKey(address);
      const raw = await this.redisClient.get(key);
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return {
            bestDifficulty: parseFloat(parsed.bestDifficulty) || 0,
            bestDifficultyUserAgent: parsed.bestDifficultyUserAgent ?? null,
          };
        } catch {
          // Corrupted JSON — fall through to PG and overwrite.
        }
      }

      const settings = await this.addressSettingsService.getSettings(address, true);
      const snapshot = {
        bestDifficulty: settings?.bestDifficulty ?? 0,
        bestDifficultyUserAgent: settings?.bestDifficultyUserAgent ?? null,
      };

      const payload = JSON.stringify(snapshot);
      await this.redisClient.set(key, payload, { EX: 3600 });

      return snapshot;
    } else {
      // Fallback in-memory implementation
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
}
