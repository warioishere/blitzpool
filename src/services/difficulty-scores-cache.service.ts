import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

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
        console.log('[DifficultyScoresCacheService] Using Redis for PM2-safe cache');
      } else {
        console.log('[DifficultyScoresCacheService] Redis not available, using in-memory cache');
      }
    } catch (error) {
      console.warn(
        '[DifficultyScoresCacheService] Failed to access Redis client, using in-memory cache:',
        error,
      );
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
      console.log(`[DifficultyScoresCache] Cache HIT for ${address} ${range}`);
      return cached;
    }

    console.log(`[DifficultyScoresCache] Cache MISS for ${address} ${range}`);

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
        console.error('[DifficultyScoresCache] Redis read error:', error);
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
        console.error('[DifficultyScoresCache] Redis write error:', error);
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
      bySlot.set(entry.slotTime, Number(entry.maxDifficulty) || 0);
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

        const keys = await this.redisClient.keys(pattern);
        if (keys && keys.length > 0) {
          await this.redisClient.del(keys);
          console.log(
            `[DifficultyScoresCache] Cleared ${keys.length} cache entries for address: ${address || 'all'}`,
          );
        }
      } catch (error) {
        console.error('[DifficultyScoresCache] Error clearing cache:', error);
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
        console.log(
          `[DifficultyScoresCache] Cleared ${keysToDelete.length} in-memory cache entries for address: ${address}`,
        );
      } else {
        const size = this.memoryCache.size;
        this.memoryCache.clear();
        console.log(`[DifficultyScoresCache] Cleared ${size} in-memory cache entries`);
      }
    }
  }
}
