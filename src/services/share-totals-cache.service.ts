import { Injectable, OnModuleDestroy, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';

interface TotalsEntry {
  baseline: number;
  delta: number;
}

/**
 * Caches aggregate share totals per address and per worker using Redis.
 *
 * Totals are hydrated from the historical aggregates on first use and then
 * incrementally updated as new shares arrive. A periodic flush persists the
 * accumulated deltas back to durable storage so that cached values remain
 * consistent across restarts. Recent deltas can be lost if the process stops
 * unexpectedly before the next flush completes.
 *
 * Redis-backed implementation ensures consistency across PM2 cluster mode workers.
 */
@Injectable()
export class ShareTotalsCacheService implements OnModuleDestroy, OnModuleInit {
  private readonly flushIntervalMs: number;
  private flushTimer?: NodeJS.Timeout;
  private redisClient: any = null;
  private useRedis: boolean = false;

  // Fallback in-memory cache if Redis is not available
  private readonly addressTotals = new Map<string, TotalsEntry>();
  private readonly workerTotals = new Map<string, Map<string, TotalsEntry>>();
  private readonly addressHydrations = new Map<string, Promise<void>>();
  private readonly workerHydrations = new Map<string, Promise<void>>();
  private readonly workerPartialHydrations = new Map<
    string,
    Map<string, Promise<void>>
  >();
  private readonly fullyHydratedAddresses = new Set<string>();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly configService: ConfigService,
  ) {
    const configuredInterval = parseInt(
      this.configService.get<string>('SHARE_TOTALS_FLUSH_INTERVAL_MS') ?? '',
      10,
    );
    if (Number.isFinite(configuredInterval) && configuredInterval > 0) {
      this.flushIntervalMs = configuredInterval;
    } else if (configuredInterval === 0) {
      this.flushIntervalMs = 0;
    } else {
      this.flushIntervalMs = 5 * 60 * 1000;
    }
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch((error) => {
          console.error('ShareTotalsCacheService flush failed', error);
        });
      }, this.flushIntervalMs);
      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  async onModuleInit(): Promise<void> {
    // Try to get the underlying Redis client from cache-manager-redis-yet
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
        console.log('[ShareTotalsCacheService] Using Redis for shared cache across PM2 workers');
      } else {
        console.log('[ShareTotalsCacheService] Redis not available, using in-memory cache');
      }
    } catch (error) {
      console.warn('[ShareTotalsCacheService] Failed to access Redis client, using in-memory cache:', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush any pending shares to database before shutdown
    console.log('[ShareTotalsCacheService] Flushing pending shares to database before shutdown...');
    try {
      await this.flush();
      console.log('[ShareTotalsCacheService] Flush on shutdown completed successfully');
    } catch (error) {
      console.error('[ShareTotalsCacheService] Failed to flush on shutdown:', error);
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

  private getAddressHydrationKey(address: string): string {
    return `shares:hydrated:address:${address}`;
  }

  private getWorkerHydrationKey(address: string): string {
    return `shares:hydrated:worker:${address}`;
  }

  public async increment(
    address: string,
    workerName: string | undefined,
    difficulty: number,
  ): Promise<void> {
    if (!address || !Number.isFinite(difficulty) || difficulty <= 0) {
      return;
    }

    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      await this.ensureAddressBaseline(address);

      // Atomically increment the delta for the address
      const addressKey = this.getAddressKey(address);
      await this.redisClient.hIncrByFloat(addressKey, 'delta', difficulty);

      if (workerName) {
        await this.ensureWorkerBaseline(address, workerName);

        // Atomically increment the delta for the worker
        const workerKey = this.getWorkerKey(address, workerName);
        await this.redisClient.hIncrByFloat(workerKey, 'delta', difficulty);
      }
    } else {
      // Fallback in-memory implementation
      await this.ensureAddressBaseline(address);
      const addressEntry = this.addressTotals.get(address);
      if (addressEntry) {
        addressEntry.delta += difficulty;
      }

      if (workerName) {
        await this.ensureWorkerBaseline(address, workerName);
        let workerMap = this.workerTotals.get(address);
        if (!workerMap) {
          workerMap = new Map();
          this.workerTotals.set(address, workerMap);
        }
        let workerEntry = workerMap.get(workerName);
        if (!workerEntry) {
          workerEntry = { baseline: 0, delta: 0 };
          workerMap.set(workerName, workerEntry);
        }
        workerEntry.delta += difficulty;
      }
    }
  }

  public async getAddressTotal(address: string): Promise<number> {
    await this.ensureAddressBaseline(address);

    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      const addressKey = this.getAddressKey(address);
      const data = await this.redisClient.hGetAll(addressKey);

      if (!data || !data.baseline) {
        // Fallback to database if not in cache
        return this.clientStatisticsService.getTotalSharesForAddress(address);
      }

      const baseline = parseFloat(data.baseline) || 0;
      const delta = parseFloat(data.delta) || 0;
      return baseline + delta;
    } else {
      // Fallback in-memory implementation
      const entry = this.addressTotals.get(address);
      if (!entry) {
        return this.clientStatisticsService.getTotalSharesForAddress(address);
      }
      return entry.baseline + entry.delta;
    }
  }

  public async getWorkerTotals(
    address: string,
  ): Promise<Array<{ workerName: string; total: number }>> {
    await this.ensureWorkerBaseline(address);

    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      const pattern = `shares:worker:${address}:*`;
      const allKeys = await this.redisClient.keys(pattern);

      if (!allKeys || allKeys.length === 0) {
        // Fallback to database if not in cache
        const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
          address,
        );
        return totals.map((entry) => ({
          workerName: entry.clientName,
          total: entry.total,
        }));
      }

      // Filter out non-data keys (hydration markers and locks)
      const dataKeys = allKeys.filter(key => !key.endsWith(':hydrated') && !key.endsWith(':lock'));

      if (dataKeys.length === 0) {
        // Only found hydration/lock keys, fallback to database
        const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
          address,
        );
        return totals.map((entry) => ({
          workerName: entry.clientName,
          total: entry.total,
        }));
      }

      const result: Array<{ workerName: string; total: number }> = [];
      const prefix = `shares:worker:${address}:`;
      for (const key of dataKeys) {
        // Extract worker name by removing the prefix (more robust than split/pop)
        const workerName = key.startsWith(prefix) ? key.substring(prefix.length) : key.split(':').pop();
        const data = await this.redisClient.hGetAll(key);
        const baseline = parseFloat(data.baseline) || 0;
        const delta = parseFloat(data.delta) || 0;
        result.push({ workerName, total: baseline + delta });
      }
      return result;
    } else {
      // Fallback in-memory implementation
      const workerMap = this.workerTotals.get(address);
      if (!workerMap) {
        const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
          address,
        );
        return totals.map((entry) => ({
          workerName: entry.clientName,
          total: entry.total,
        }));
      }
      const result: Array<{ workerName: string; total: number }> = [];
      for (const [workerName, entry] of workerMap.entries()) {
        result.push({ workerName, total: entry.baseline + entry.delta });
      }
      return result;
    }
  }

  public async flush(): Promise<void> {
    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      const pending: Promise<void>[] = [];
      const pattern = 'shares:address:*';
      const keys = await this.redisClient.keys(pattern);

      for (const key of keys) {
        const data = await this.redisClient.hGetAll(key);
        const delta = parseFloat(data.delta) || 0;

        if (delta <= 0) {
          continue;
        }

        const address = key.replace('shares:address:', '');
        const baseline = parseFloat(data.baseline) || 0;

        // Move delta to baseline atomically using Lua script
        const luaScript = `
          local key = KEYS[1]
          local delta = tonumber(redis.call('HGET', key, 'delta'))
          if delta and delta > 0 then
            redis.call('HINCRBYFLOAT', key, 'baseline', delta)
            redis.call('HSET', key, 'delta', '0')
            return delta
          end
          return 0
        `;

        pending.push(
          (async () => {
            try {
              const flushedDelta = await this.redisClient.eval(luaScript, {
                keys: [key],
              });

              if (flushedDelta > 0) {
                await this.addressSettingsService.addShares(address, flushedDelta);
              }
            } catch (error) {
              // Rollback on error
              await this.redisClient.hIncrByFloat(key, 'baseline', -delta);
              await this.redisClient.hIncrByFloat(key, 'delta', delta);
              console.error('ShareTotalsCacheService failed to persist shares', error);
            }
          })(),
        );
      }

      // Also flush worker totals (update baseline, reset delta)
      const workerPattern = 'shares:worker:*';
      const allWorkerKeys = await this.redisClient.keys(workerPattern);

      // Filter out non-data keys (hydration markers and locks)
      const workerDataKeys = allWorkerKeys.filter(key => !key.endsWith(':hydrated') && !key.endsWith(':lock'));

      for (const key of workerDataKeys) {
        const data = await this.redisClient.hGetAll(key);
        const delta = parseFloat(data.delta) || 0;

        if (delta > 0) {
          const luaScript = `
            local key = KEYS[1]
            local delta = tonumber(redis.call('HGET', key, 'delta'))
            if delta and delta > 0 then
              redis.call('HINCRBYFLOAT', key, 'baseline', delta)
              redis.call('HSET', key, 'delta', '0')
            end
          `;
          await this.redisClient.eval(luaScript, { keys: [key] });
        }
      }

      await Promise.all(pending);
    } else {
      // Fallback in-memory implementation
      const pending: Promise<void>[] = [];
      for (const [address, entry] of this.addressTotals.entries()) {
        if (entry.delta <= 0) {
          continue;
        }
        const delta = entry.delta;
        entry.baseline += delta;
        entry.delta = 0;
        pending.push(
          this.addressSettingsService
            .addShares(address, delta)
            .catch((error) => {
              entry.baseline -= delta;
              entry.delta += delta;
              console.error('ShareTotalsCacheService failed to persist shares', error);
            })
            .then(() => void 0),
        );
      }

      for (const workerMap of this.workerTotals.values()) {
        for (const entry of workerMap.values()) {
          if (entry.delta > 0) {
            entry.baseline += entry.delta;
            entry.delta = 0;
          }
        }
      }

      await Promise.all(pending);
    }
  }

  private async ensureAddressBaseline(address: string): Promise<void> {
    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      const addressKey = this.getAddressKey(address);
      const hydrationKey = this.getAddressHydrationKey(address);

      // Check if already hydrated
      const isHydrated = await this.redisClient.get(hydrationKey);
      if (isHydrated) {
        return;
      }

      // Use a Redis lock to prevent concurrent hydration
      const lockKey = `${hydrationKey}:lock`;
      const lockAcquired = await this.redisClient.set(lockKey, '1', {
        NX: true,
        EX: 30, // Lock expires after 30 seconds
      });

      if (lockAcquired) {
        try {
          // Load baseline from database
          const total = await this.clientStatisticsService.getTotalSharesForAddress(
            address,
          );

          // Store in Redis
          await this.redisClient.hSet(addressKey, {
            baseline: total.toString(),
            delta: '0',
          });

          // Mark as hydrated
          await this.redisClient.set(hydrationKey, '1', { EX: 3600 }); // Expires in 1 hour
        } finally {
          await this.redisClient.del(lockKey);
        }
      } else {
        // Wait for another process to finish hydration
        let attempts = 0;
        while (attempts < 30) {
          const stillHydrating = await this.redisClient.get(lockKey);
          if (!stillHydrating) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          attempts++;
        }
      }
    } else {
      // Fallback in-memory implementation
      if (this.addressTotals.has(address)) {
        return;
      }
      let hydration = this.addressHydrations.get(address);
      if (!hydration) {
        hydration = (async () => {
          const total = await this.clientStatisticsService.getTotalSharesForAddress(
            address,
          );
          this.addressTotals.set(address, { baseline: total, delta: 0 });
        })();
        this.addressHydrations.set(address, hydration);
      }
      await hydration;
    }
  }

  private async ensureWorkerBaseline(
    address: string,
    workerName?: string,
  ): Promise<void> {
    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      if (workerName) {
        // Hydrate specific worker
        const workerKey = this.getWorkerKey(address, workerName);
        const hydrationKey = `${workerKey}:hydrated`;

        const isHydrated = await this.redisClient.get(hydrationKey);
        if (isHydrated) {
          return;
        }

        const lockKey = `${hydrationKey}:lock`;
        const lockAcquired = await this.redisClient.set(lockKey, '1', {
          NX: true,
          EX: 30,
        });

        if (lockAcquired) {
          try {
            const total =
              await this.clientStatisticsService.getTotalSharesForWorker(
                address,
                workerName,
              );
            await this.redisClient.hSet(workerKey, {
              baseline: total.toString(),
              delta: '0',
            });
            await this.redisClient.set(hydrationKey, '1', { EX: 3600 });
          } finally {
            await this.redisClient.del(lockKey);
          }
        } else {
          // Wait for hydration
          let attempts = 0;
          while (attempts < 30) {
            const stillHydrating = await this.redisClient.get(lockKey);
            if (!stillHydrating) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
          }
        }
        return;
      } else {
        // Hydrate all workers for address
        const hydrationKey = this.getWorkerHydrationKey(address);
        const isHydrated = await this.redisClient.get(hydrationKey);
        if (isHydrated) {
          return;
        }

        const lockKey = `${hydrationKey}:lock`;
        const lockAcquired = await this.redisClient.set(lockKey, '1', {
          NX: true,
          EX: 30,
        });

        if (lockAcquired) {
          try {
            const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
              address,
            );
            for (const total of totals) {
              const workerKey = this.getWorkerKey(address, total.clientName);
              const existing = await this.redisClient.hGetAll(workerKey);
              const existingBaseline = parseFloat(existing.baseline) || 0;
              const newBaseline = Math.max(existingBaseline, total.total);

              await this.redisClient.hSet(workerKey, {
                baseline: newBaseline.toString(),
                delta: existing.delta || '0',
              });
            }
            await this.redisClient.set(hydrationKey, '1', { EX: 3600 });
          } finally {
            await this.redisClient.del(lockKey);
          }
        } else {
          // Wait for hydration
          let attempts = 0;
          while (attempts < 30) {
            const stillHydrating = await this.redisClient.get(lockKey);
            if (!stillHydrating) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
          }
        }
      }
    } else {
      // Fallback in-memory implementation
      if (workerName) {
        const workerMap = this.workerTotals.get(address);
        if (workerMap?.has(workerName)) {
          return;
        }

        let partialHydrations = this.workerPartialHydrations.get(address);
        if (!partialHydrations) {
          partialHydrations = new Map();
          this.workerPartialHydrations.set(address, partialHydrations);
        }

        let hydration = partialHydrations.get(workerName);
        if (!hydration) {
          hydration = (async () => {
            const total =
              await this.clientStatisticsService.getTotalSharesForWorker(
                address,
                workerName,
              );
            let map = this.workerTotals.get(address);
            if (!map) {
              map = new Map();
              this.workerTotals.set(address, map);
            }
            const entry = map.get(workerName);
            if (entry) {
              entry.baseline = total;
            } else {
              map.set(workerName, { baseline: total, delta: 0 });
            }
          })();
          partialHydrations.set(workerName, hydration);
        }

        try {
          await hydration;
        } finally {
          partialHydrations.delete(workerName);
          if (partialHydrations.size === 0) {
            this.workerPartialHydrations.delete(address);
          }
        }

        return;
      }

      if (this.fullyHydratedAddresses.has(address) && this.workerTotals.has(address)) {
        return;
      }

      const pendingPartials = this.workerPartialHydrations.get(address);
      if (pendingPartials && pendingPartials.size > 0) {
        await Promise.all(pendingPartials.values());
      }

      let hydration = this.workerHydrations.get(address);
      if (!hydration) {
        hydration = (async () => {
          const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
            address,
          );
          let map = this.workerTotals.get(address);
          if (!map) {
            map = new Map();
            this.workerTotals.set(address, map);
          }
          for (const total of totals) {
            const entry = map.get(total.clientName);
            if (entry) {
              entry.baseline = Math.max(entry.baseline, total.total);
            } else {
              map.set(total.clientName, { baseline: total.total, delta: 0 });
            }
          }
          this.fullyHydratedAddresses.add(address);
        })();
        this.workerHydrations.set(address, hydration);
      }

      try {
        await hydration;
      } finally {
        this.workerHydrations.delete(address);
      }

      if (!this.workerTotals.has(address)) {
        this.workerTotals.set(address, new Map());
      }
    }
  }
}
