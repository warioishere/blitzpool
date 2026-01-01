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

  // Fallback hydration tracking (for non-Redis mode only)
  private readonly addressHydrations = new Map<string, Promise<void>>();
  private readonly workerHydrations = new Map<string, Promise<void>>();
  private readonly workerPartialHydrations = new Map<
    string,
    Map<string, Promise<void>>
  >();
  private readonly fullyHydratedAddresses = new Set<string>();

  // NEW: In-memory delta buffers for Redis mode (high-performance hot path)
  private readonly addressDeltas = new Map<string, number>();
  private readonly workerDeltas = new Map<string, Map<string, number>>();

  // NEW: In-memory hydration tracking for Redis mode (no expiring markers)
  private readonly hydratedAddresses = new Set<string>();
  private readonly hydratedWorkers = new Map<string, Set<string>>();

  // NEW: Flush state management
  private isFlushing = false;
  private currentTimeSlot: number | null = null;

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

  public increment(
    address: string,
    workerName: string | undefined,
    difficulty: number,
  ): void {
    if (!address || !Number.isFinite(difficulty) || difficulty <= 0) {
      return;
    }

    if (this.useRedis && this.redisClient) {
      // NEW: High-performance Redis mode - pure in-memory operations
      // Accumulate deltas in memory, flush to Redis periodically

      // 1. Update address delta (Map operation ~0.001ms)
      const currentAddressDelta = this.addressDeltas.get(address) || 0;
      this.addressDeltas.set(address, currentAddressDelta + difficulty);

      // 2. Update worker delta if specified
      if (workerName) {
        let workerMap = this.workerDeltas.get(address);
        if (!workerMap) {
          workerMap = new Map();
          this.workerDeltas.set(address, workerMap);
        }
        const currentWorkerDelta = workerMap.get(workerName) || 0;
        workerMap.set(workerName, currentWorkerDelta + difficulty);
      }

      // 3. Check time slot transition (non-blocking flush trigger)
      this.checkSlotTransition();
    } else {
      // Fallback in-memory implementation (unchanged)
      // This path is async but only used when Redis is not available
      this.incrementFallback(address, workerName, difficulty);
    }
  }

  private async incrementFallback(
    address: string,
    workerName: string | undefined,
    difficulty: number,
  ): Promise<void> {
    // Use existing fallback hydration logic (non-Redis mode)
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

  /**
   * Calculate current 10-minute time slot (end-time labeled)
   * Same logic as statistics-batch.service.ts
   */
  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10; // 10 minutes
    return Math.floor(Date.now() / coeff) * coeff + coeff;
  }

  /**
   * Check for time slot transition and trigger immediate flush
   * Ensures statistics are persisted when moving to new 10-min slot
   */
  private checkSlotTransition(): void {
    const currentSlot = this.getTimeSlot();

    if (this.currentTimeSlot === null || this.currentTimeSlot === currentSlot) {
      this.currentTimeSlot = currentSlot;
      return;
    }

    // Slot transition detected - trigger immediate flush (non-blocking)
    console.log(
      `[ShareTotalsCache] Slot transition detected (${this.currentTimeSlot} -> ${currentSlot}), flushing immediately`,
    );
    this.currentTimeSlot = currentSlot;

    // Non-blocking async flush
    this.flush().catch((error) => {
      console.error('[ShareTotalsCache] Slot transition flush failed:', error);
    });
  }

  public async getAddressTotal(address: string): Promise<number> {
    if (this.useRedis && this.redisClient) {
      // NEW: High-performance Redis read path
      // Check in-memory deltas first (most recent data not yet flushed)
      const inMemoryDelta = this.addressDeltas.get(address) || 0;

      // Get from Redis
      const addressKey = this.getAddressKey(address);
      const data = await this.redisClient.hGetAll(addressKey);

      if (data && data.baseline !== undefined) {
        const baseline = parseFloat(data.baseline) || 0;
        const redisDelta = parseFloat(data.delta) || 0;
        return baseline + redisDelta + inMemoryDelta;
      }

      // Not in Redis - load from database and add in-memory delta
      const total = await this.clientStatisticsService.getTotalSharesForAddress(address);
      return total + inMemoryDelta;
    } else {
      // Fallback in-memory implementation (unchanged)
      await this.ensureAddressBaseline(address);
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
    if (this.useRedis && this.redisClient) {
      // NEW: High-performance Redis read path
      // Get in-memory deltas (most recent data not yet flushed)
      const inMemoryWorkerDeltas = this.workerDeltas.get(address) || new Map();

      // Get from Redis
      const pattern = `shares:worker:${address}:*`;
      const allKeys = await this.redisClient.keys(pattern);

      // Build result map to merge Redis data with in-memory deltas
      const resultMap = new Map<string, number>();

      if (allKeys && allKeys.length > 0) {
        // Filter out non-data keys (hydration markers and locks)
        const dataKeys = allKeys.filter(key => !key.endsWith(':hydrated') && !key.endsWith(':lock'));

        const prefix = `shares:worker:${address}:`;
        for (const key of dataKeys) {
          // Extract worker name by removing the prefix
          const workerName = key.startsWith(prefix) ? key.substring(prefix.length) : key.split(':').pop();
          const data = await this.redisClient.hGetAll(key);
          const baseline = parseFloat(data.baseline) || 0;
          const redisDelta = parseFloat(data.delta) || 0;
          resultMap.set(workerName, baseline + redisDelta);
        }
      }

      // If no Redis data, load from database
      if (resultMap.size === 0) {
        const dbTotals = await this.clientStatisticsService.getTotalSharesForWorkers(address);
        for (const entry of dbTotals) {
          resultMap.set(entry.clientName, entry.total);
        }
      }

      // Merge in-memory deltas
      for (const [workerName, inMemoryDelta] of inMemoryWorkerDeltas) {
        const current = resultMap.get(workerName) || 0;
        resultMap.set(workerName, current + inMemoryDelta);
      }

      // Convert to array
      const result: Array<{ workerName: string; total: number }> = [];
      for (const [workerName, total] of resultMap) {
        result.push({ workerName, total });
      }
      return result;
    } else {
      // Fallback in-memory implementation (unchanged)
      await this.ensureWorkerBaseline(address);
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
      // HYBRID: Fast increment() + Production-safe flush()
      if (this.isFlushing) {
        return; // Prevent concurrent flushes
      }

      this.isFlushing = true;

      try {
        // STEP 1: Flush in-memory buffers to Redis delta (NEW - from fast increment())
        if (this.addressDeltas.size > 0 || this.workerDeltas.size > 0) {
          const addressSnapshot = new Map(this.addressDeltas);
          const workerSnapshot = new Map(this.workerDeltas);
          this.addressDeltas.clear();
          this.workerDeltas.clear();

          const pipeline = this.redisClient.multi();

          // Add in-memory address deltas to Redis
          for (const [address, delta] of addressSnapshot) {
            const addressKey = this.getAddressKey(address);

            // Lazy hydration: only load baseline if needed
            if (!this.hydratedAddresses.has(address)) {
              const exists = await this.redisClient.exists(addressKey);
              if (!exists) {
                const baseline =
                  await this.clientStatisticsService.getTotalSharesForAddress(
                    address,
                  );
                pipeline.hSet(addressKey, {
                  baseline: baseline.toString(),
                  delta: '0',
                });
              }
              this.hydratedAddresses.add(address);
            }

            // Add to Redis delta (aggregates from all PM2 instances)
            pipeline.hIncrByFloat(addressKey, 'delta', delta);
          }

          // Add in-memory worker deltas to Redis
          for (const [address, workerMap] of workerSnapshot) {
            for (const [workerName, delta] of workerMap) {
              const workerKey = this.getWorkerKey(address, workerName);

              // Lazy hydration for workers
              const workerSet = this.hydratedWorkers.get(address);
              if (!workerSet || !workerSet.has(workerName)) {
                const exists = await this.redisClient.exists(workerKey);
                if (!exists) {
                  const baseline =
                    await this.clientStatisticsService.getTotalSharesForWorker(
                      address,
                      workerName,
                    );
                  pipeline.hSet(workerKey, {
                    baseline: baseline.toString(),
                    delta: '0',
                  });
                }

                if (!workerSet) {
                  this.hydratedWorkers.set(address, new Set([workerName]));
                } else {
                  workerSet.add(workerName);
                }
              }

              pipeline.hIncrByFloat(workerKey, 'delta', delta);
            }
          }

          await pipeline.exec();
        }

        // STEP 2: Process ALL Redis keys (EXACTLY like production)
        // This handles deltas from all PM2 instances + what we just added
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

          // EXACTLY like production - Lua script atomically moves delta → baseline
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
              let flushedDelta = 0;
              try {
                flushedDelta = await this.redisClient.eval(luaScript, {
                  keys: [key],
                });

                if (flushedDelta > 0) {
                  await this.addressSettingsService.addShares(
                    address,
                    flushedDelta,
                  );
                }
              } catch (error) {
                // EXACTLY like production - rollback on error
                if (flushedDelta > 0) {
                  await this.redisClient.hIncrByFloat(
                    key,
                    'baseline',
                    -flushedDelta,
                  );
                  await this.redisClient.hIncrByFloat(key, 'delta', flushedDelta);
                }
                console.error(
                  'ShareTotalsCacheService failed to persist shares',
                  error,
                );
              }
            })(),
          );
        }

        // STEP 3: Process worker totals (EXACTLY like production)
        const workerPattern = 'shares:worker:*';
        const allWorkerKeys = await this.redisClient.keys(workerPattern);

        // Filter out non-data keys (hydration markers and locks)
        const workerDataKeys = allWorkerKeys.filter(
          (key) => !key.endsWith(':hydrated') && !key.endsWith(':lock'),
        );

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
      } catch (error) {
        console.error('[ShareTotalsCache] Flush failed:', error);
      } finally {
        this.isFlushing = false;
      }
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

  /**
   * Ensure address baseline is loaded (FALLBACK MODE ONLY)
   * Note: Redis mode now uses lazy hydration in flush(), not this method
   */
  private async ensureAddressBaseline(address: string): Promise<void> {
    // Only used for fallback in-memory implementation (when Redis is not available)
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

  /**
   * Ensure worker baseline is loaded (FALLBACK MODE ONLY)
   * Note: Redis mode now uses lazy hydration in flush(), not this method
   */
  private async ensureWorkerBaseline(
    address: string,
    workerName?: string,
  ): Promise<void> {
    // Only used for fallback in-memory implementation (when Redis is not available)
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
