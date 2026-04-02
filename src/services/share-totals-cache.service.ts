import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';

/**
 * Caches aggregate share totals per address and per worker using Redis.
 *
 * Uses direct atomic Redis increments (no in-memory buffering or baseline+delta pattern).
 * StatisticsCoordinator handles persistence to the database.
 *
 * Redis-backed for persistence across restarts.
 */
@Injectable()
export class ShareTotalsCacheService implements OnModuleInit {
  private redisClient: any = null;
  private useRedis: boolean = false;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientStatisticsService: ClientStatisticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Try to get the underlying Redis client from cache-manager-redis-yet
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
        console.log('[ShareTotalsCacheService] Using Redis for atomic share increments (StatisticsCoordinator handles flush)');
      } else {
        console.log('[ShareTotalsCacheService] Redis not available, share tracking disabled');
      }
    } catch (error) {
      console.warn('[ShareTotalsCacheService] Failed to access Redis client:', error);
    }
  }

  /**
   * Redis key helpers
   */
  private getAddressKey(address: string): string {
    return `shares:address:${address}`;
  }

  private getWorkerKey(address: string, workerName: string): string {
    return `shares:worker:${address}:${workerName}`;
  }

  /**
   * Increment share totals atomically in Redis.
   * StatisticsCoordinator will flush to database.
   */
  public increment(
    address: string,
    workerName: string | undefined,
    difficulty: number,
  ): void {
    if (!address || !Number.isFinite(difficulty) || difficulty <= 0) {
      return;
    }

    if (!this.useRedis || !this.redisClient) {
      // Redis not available - silently skip (share tracking disabled)
      return;
    }

    // Direct atomic Redis increments (fire-and-forget for performance)
    const addressKey = this.getAddressKey(address);

    this.redisClient.hIncrByFloat(addressKey, 'delta', difficulty).catch(err => {
      console.error(`[ShareTotalsCacheService] Failed to increment address ${address}:`, err);
    });

    if (workerName) {
      const workerKey = this.getWorkerKey(address, workerName);
      this.redisClient.hIncrByFloat(workerKey, 'delta', difficulty).catch(err => {
        console.error(`[ShareTotalsCacheService] Failed to increment worker ${address}:${workerName}:`, err);
      });
    }
  }

  /**
   * Get total shares for an address from Redis.
   * Lazy-loads from database if Redis is empty (e.g., after restart).
   */
  public async getAddressTotal(address: string): Promise<number> {
    if (!this.useRedis || !this.redisClient) {
      // Fallback to database query if Redis not available
      return this.clientStatisticsService.getTotalSharesForAddress(address);
    }

    const addressKey = this.getAddressKey(address);
    const data = await this.redisClient.hGetAll(addressKey);

    // If Redis has data, return baseline + delta
    if (data && (data.baseline !== undefined || data.delta !== undefined)) {
      const baseline = parseFloat(data.baseline) || 0;
      const delta = parseFloat(data.delta) || 0;
      return baseline + delta;
    }

    // Redis is empty (e.g., after restart) - lazy load from database
    const dbTotal = await this.clientStatisticsService.getTotalSharesForAddress(address);

    // Hydrate Redis cache with database value as baseline
    if (dbTotal > 0) {
      await this.redisClient.hSet(addressKey, {
        baseline: dbTotal.toString(),
        delta: '0',
      }).catch(err => {
        console.error(`[ShareTotalsCacheService] Failed to hydrate baseline for ${address}:`, err);
      });
    }

    return dbTotal;
  }

  /**
   * Get total shares for all workers of an address from Redis.
   * Lazy-loads from database if Redis is empty (e.g., after restart).
   */
  public async getWorkerTotals(
    address: string,
  ): Promise<Array<{ workerName: string; total: number }>> {
    if (!this.useRedis || !this.redisClient) {
      // Fallback to database query if Redis not available
      const totals = await this.clientStatisticsService.getTotalSharesForWorkers(address);
      return totals.map((entry) => ({
        workerName: entry.clientName,
        total: entry.total,
      }));
    }

    const pattern = `shares:worker:${address}:*`;
    const allKeys = await this.redisClient.keys(pattern);

    const result: Array<{ workerName: string; total: number }> = [];

    // If Redis has worker data, use it
    if (allKeys && allKeys.length > 0) {
      // Filter out non-data keys (hydration markers and locks)
      const dataKeys = allKeys.filter(key => !key.endsWith(':hydrated') && !key.endsWith(':lock'));
      const prefix = `shares:worker:${address}:`;

      for (const key of dataKeys) {
        // Extract worker name by removing the prefix
        const workerName = key.startsWith(prefix) ? key.substring(prefix.length) : key.split(':').pop() || '';

        if (!workerName) {
          continue;
        }

        const data = await this.redisClient.hGetAll(key);

        if (!data || (data.baseline === undefined && data.delta === undefined)) {
          continue;
        }

        const baseline = parseFloat(data.baseline) || 0;
        const delta = parseFloat(data.delta) || 0;
        const total = baseline + delta;

        if (total > 0) {
          result.push({ workerName, total });
        }
      }

      return result;
    }

    // Redis is empty (e.g., after restart) - lazy load from database
    const dbTotals = await this.clientStatisticsService.getTotalSharesForWorkers(address);

    // Hydrate Redis cache with database values as baselines
    for (const entry of dbTotals) {
      if (entry.total > 0) {
        const workerKey = this.getWorkerKey(address, entry.clientName);
        await this.redisClient.hSet(workerKey, {
          baseline: entry.total.toString(),
          delta: '0',
        }).catch(err => {
          console.error(`[ShareTotalsCacheService] Failed to hydrate worker ${address}:${entry.clientName}:`, err);
        });

        result.push({
          workerName: entry.clientName,
          total: entry.total,
        });
      }
    }

    return result;
  }

  /**
   * Clear all Redis cache keys for an address (used for delete operations)
   */
  public async clearAddressData(address: string): Promise<void> {
    if (!this.useRedis || !this.redisClient) {
      return;
    }

    try {
      // Delete address total key
      const addressKey = this.getAddressKey(address);
      await this.redisClient.del(addressKey);

      // Delete all worker keys for this address
      const workerPattern = `shares:worker:${address}:*`;
      const workerKeys = await this.redisClient.keys(workerPattern);

      if (workerKeys && workerKeys.length > 0) {
        await this.redisClient.del(...workerKeys);
      }
    } catch (error) {
      console.error(`[ShareTotalsCacheService] Failed to clear data for address ${address}:`, error);
    }
  }
}
