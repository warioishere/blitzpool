import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';

export interface DifficultyScoreSlot {
  time: string;
  difficulty: number;
}

export interface DifficultyScoresResult {
  slotData: DifficultyScoreSlot[];
}

@Injectable()
export class DifficultyScoresCacheService implements OnModuleInit {
  private redisClient: any = null;
  private useRedis: boolean = false;

  // Fallback in-memory cache
  private readonly memoryCache = new Map<string, DifficultyScoresResult>();

  constructor(
    private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
      }
    } catch (error) {
      // Silently fall back to in-memory cache
    }
  }

  /**
   * Get difficulty scores with caching.
   * This is the main public method called by the controller.
   */
  async getDifficultyScores(
    address: string,
    range: '1d' | '7d' | '30d',
    startSlot: number,
    endSlot: number,
  ): Promise<DifficultyScoresResult> {
    // Generate cache key using endSlot (already calculated by controller)
    // This ensures cache key matches the data range and avoids time-drift bugs
    const cacheKey = this.getCacheKey(address, range, endSlot);

    // Try to get from cache (Redis or in-memory)
    const cached = await this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Load from database
    const result = await this.loadFromDatabase(address, startSlot, endSlot);

    // Store in cache with TTL
    await this.storeInCache(cacheKey, result, range);

    return result;
  }

  /**
   * Generate cache key aligned to hourly boundaries using controller-provided endSlot.
   * Using endSlot (from controller) ensures cache key matches the data range exactly,
   * avoiding time-drift issues when service processing crosses hour boundaries.
   * All requests within the same hour use the same key, improving cache hit rates.
   */
  private getCacheKey(
    address: string,
    range: '1d' | '7d' | '30d',
    endSlot: number,
  ): string {
    return `diffscores:${address}:${range}:${endSlot}`;
  }

  private async getFromCache(key: string): Promise<DifficultyScoresResult | null> {
    if (this.useRedis && this.redisClient) {
      // Redis implementation
      try {
        const data = await this.redisClient.get(key);
        if (data) {
          return JSON.parse(data);
        }
      } catch (error) {
        // Silently fail
      }
      return null;
    } else {
      // In-memory fallback
      return this.memoryCache.get(key) ?? null;
    }
  }

  private async storeInCache(
    key: string,
    value: DifficultyScoresResult,
    range: '1d' | '7d' | '30d',
  ): Promise<void> {
    const ttl = this.getTTLForRange(range);

    if (this.useRedis && this.redisClient) {
      // Redis implementation
      try {
        await this.redisClient.setEx(key, ttl, JSON.stringify(value));
      } catch (error) {
        // Silently fail
      }
    } else {
      // In-memory fallback (no automatic expiration, but simpler)
      this.memoryCache.set(key, value);

      // Optional: Manual cleanup after TTL for in-memory cache
      setTimeout(() => {
        this.memoryCache.delete(key);
      }, ttl * 1000);
    }
  }

  private getTTLForRange(range: '1d' | '7d' | '30d'): number {
    // Return TTL in seconds
    switch (range) {
      case '1d':
        return 300; // 5 minutes
      case '7d':
        return 1800; // 30 minutes
      case '30d':
        return 7200; // 2 hours
      default:
        return 600; // 10 minutes fallback
    }
  }

  private async loadFromDatabase(
    address: string,
    startSlot: number,
    endSlot: number,
  ): Promise<DifficultyScoresResult> {
    const rawEntries = await this.clientDifficultyStatisticsService.getMaximaForAddress(
      address,
      startSlot,
      endSlot,
    );

    const bySlot = new Map<number, number>();
    for (const entry of rawEntries) {
      bySlot.set(Number(entry.slotTime), Number(entry.maxDifficulty) || 0);
    }

    const slotData: DifficultyScoreSlot[] = [];
    const oneHour = 60 * 60 * 1000;
    for (let t = startSlot; t <= endSlot; t += oneHour) {
      slotData.push({
        time: new Date(t).toISOString(),
        difficulty: bySlot.get(t) ?? 0,
      });
    }

    return { slotData };
  }

  /**
   * Clear cache for a specific address or all addresses.
   * Called when best difficulty is reset or when cache invalidation is needed.
   */
  async clearCache(address?: string, range?: '1d' | '7d' | '30d'): Promise<void> {
    if (this.useRedis && this.redisClient) {
      try {
        let pattern: string;
        if (address && range) {
          // Clear all cache entries for this address and range (including all hour boundaries)
          pattern = `diffscores:${address}:${range}:*`;
        } else if (address) {
          // Clear all cache entries for this address (all ranges, all hours)
          pattern = `diffscores:${address}:*`;
        } else {
          // Clear all difficulty scores cache
          pattern = `diffscores:*`;
        }

        let cursor = '0';
        do {
          const result = await this.redisClient.scan(cursor, { MATCH: pattern, COUNT: 1000 });
          cursor = result.cursor.toString();
          if (result.keys.length > 0) {
            await this.redisClient.del(result.keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        // Silently fail
      }
    } else {
      // Clear in-memory cache
      if (address) {
        const keysToDelete: string[] = [];
        for (const key of this.memoryCache.keys()) {
          if (key.startsWith(`diffscores:${address}:`)) {
            if (!range || key.includes(`:${range}:`)) {
              keysToDelete.push(key);
            }
          }
        }
        keysToDelete.forEach((k) => this.memoryCache.delete(k));
      } else {
        this.memoryCache.clear();
      }
    }
  }
}
