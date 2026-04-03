import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';
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
    private readonly addressSettingsService: AddressSettingsService,
    private readonly workerSharesService: WorkerSharesService,
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
      // Fallback: read cumulative total from address_settings (all-time, not affected by old-stats cleanup)
      const settings = await this.addressSettingsService.getSettings(address, false);
      return settings?.shares ?? 0;
    }

    const addressKey = this.getAddressKey(address);
    const data = await this.redisClient.hGetAll(addressKey);

    // If Redis has data, return baseline + delta
    if (data && (data.baseline !== undefined || data.delta !== undefined)) {
      const baseline = parseFloat(data.baseline) || 0;
      const delta = parseFloat(data.delta) || 0;
      return baseline + delta;
    }

    // Redis is empty (e.g., after restart) - lazy load from address_settings (cumulative all-time total)
    const settings = await this.addressSettingsService.getSettings(address, false);
    const dbTotal = settings?.shares ?? 0;

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
   * Get total shares for all workers of an address.
   * Reads cumulative totals from worker_shares_entity + unflushed Redis deltas.
   */
  public async getWorkerTotals(
    address: string,
  ): Promise<Array<{ workerName: string; total: number }>> {
    // Read cumulative totals from worker_shares_entity
    const dbTotals = await this.workerSharesService.getWorkerTotals(address);
    const totalsMap = new Map(dbTotals.map(e => [e.clientName, e.shares]));

    // Add unflushed Redis deltas if available
    if (this.useRedis && this.redisClient) {
      const prefix = `shares:worker:${address}:`;
      const allKeys = await this.scanWorkerKeys(address);
      const validKeys = allKeys.filter(k => !k.endsWith(':hydrated') && !k.endsWith(':lock'));

      if (validKeys.length > 0) {
        const hashes = await Promise.all(validKeys.map(k => this.redisClient.hGetAll(k)));
        for (let i = 0; i < validKeys.length; i++) {
          const workerName = validKeys[i].startsWith(prefix)
            ? validKeys[i].substring(prefix.length)
            : '';
          if (!workerName) continue;
          const delta = parseFloat(hashes[i]?.delta) || 0;
          if (delta > 0) {
            totalsMap.set(workerName, (totalsMap.get(workerName) || 0) + delta);
          }
        }
      }
    }

    return Array.from(totalsMap.entries())
      .filter(([_, total]) => total > 0)
      .map(([workerName, total]) => ({ workerName, total }));
  }

  /**
   * Clear all Redis cache keys for an address (used for delete operations)
   */
  public async clearAddressData(address: string): Promise<void> {
    if (!this.useRedis || !this.redisClient) {
      return;
    }

    try {
      const addressKey = this.getAddressKey(address);
      await this.redisClient.del(addressKey);

      const workerKeys = await this.scanWorkerKeys(address);
      if (workerKeys.length > 0) {
        await this.redisClient.del(workerKeys);
      }
    } catch (error) {
      console.error(`[ShareTotalsCacheService] Failed to clear data for address ${address}:`, error);
    }
  }

  /**
   * Iterate Redis keyspace with SCAN to find all worker keys for an address.
   * SCAN is non-blocking (unlike KEYS) and safe to use in production.
   */
  private async scanWorkerKeys(address: string): Promise<string[]> {
    const pattern = `shares:worker:${address}:*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor.toString();
      if (result.keys?.length) {
        keys.push(...result.keys);
      }
    } while (cursor !== '0');
    return keys;
  }
}
