import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { StratumV1Service } from './stratum-v1.service';
import { createClient, RedisClientType } from 'redis';

export interface HashrateDataPoint {
  label: string;
  data: number;
}

@Injectable()
export class LiveHashrateService implements OnModuleInit, OnModuleDestroy {
  private collectionInterval: NodeJS.Timeout;
  private aggregationInterval: NodeJS.Timeout;
  private redis: RedisClientType;
  private instanceId: string;
  private readonly isPrimaryInstance: boolean;
  private readonly COLLECTION_INTERVAL_MS = 60000; // 60 seconds
  private readonly AGGREGATION_INTERVAL_MS = 180000; // 3 minutes (reduced from 30s to prevent CPU spikes)
  private readonly RETENTION_HOURS = 24;
  private readonly RETENTION_SECONDS = this.RETENTION_HOURS * 3600;
  private readonly POOL_PREFIX = 'livehash:pool';
  private readonly ADDR_PREFIX = 'livehash:addr';
  private readonly INSTANCE_PREFIX = 'livehash:i';

  // Aggregation tracking
  private aggregationMetrics = {
    totalAggregations: 0,
    successfulAggregations: 0,
    failedAggregations: 0,
    droppedStaleInstances: 0,
    deduplicatedAddresses: 0,
    lastAggregationTime: 0,
    lastError: '',
  };

  constructor(
    private readonly stratumV1Service: StratumV1Service,
    private readonly configService: ConfigService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
  ) {
    // Check multiple PM2 environment variables (pm2-runtime uses pm_id, pm2 uses NODE_APP_INSTANCE)
    const pm2InstanceId = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID;
    this.instanceId = pm2InstanceId ?? '0';

    const normalizedInstanceId = typeof pm2InstanceId === 'string' ? pm2InstanceId.trim() : undefined;
    this.isPrimaryInstance = !normalizedInstanceId || normalizedInstanceId === '0';
  }

  /**
   * Scan Redis keys using cursor-based iteration (non-blocking)
   * This is the production-safe alternative to KEYS command
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    if (!this.redis) return [];

    const keys: string[] = [];
    let cursor = 0;

    try {
      do {
        const result = await this.redis.scan(cursor, {
          MATCH: pattern,
          COUNT: 100, // Scan in batches of 100
        });

        cursor = result.cursor;
        keys.push(...result.keys);
      } while (cursor !== 0);

      return keys;
    } catch (error) {
      console.error(`[LiveHashrate] Error scanning keys with pattern ${pattern}:`, error);
      return [];
    }
  }

  async onModuleInit() {
    // Initialize Redis connection for live hashrate storage
    const redisHost = this.configService.get('REDIS_HOST');
    const redisPort = parseInt(this.configService.get('REDIS_PORT') ?? '6379');
    const redisPassword = this.configService.get('REDIS_PASSWORD');
    const redisDb = parseInt(this.configService.get('REDIS_DB') ?? '0');

    if (redisHost) {
      try {
        this.redis = createClient({
          socket: {
            host: redisHost,
            port: redisPort,
          },
          password: redisPassword ? redisPassword : undefined,
          database: redisDb,
        });

        await this.redis.connect();
        console.log('[LiveHashrate] Redis connection established');
      } catch (error) {
        console.error('[LiveHashrate] Failed to connect to Redis:', error);
        // Don't throw - graceful degradation
      }
    } else {
      console.warn('[LiveHashrate] Redis not configured - live hashrate will not persist');
    }

    // Start the background collection job
    this.collectionInterval = setInterval(
      () => this.collectAndStoreCurrentHashrate(),
      this.COLLECTION_INTERVAL_MS,
    );

    // Start aggregation job to combine data from all instances (only on primary instance)
    if (this.isPrimaryInstance) {
      this.aggregationInterval = setInterval(
        () => this.aggregateInstanceData(),
        this.AGGREGATION_INTERVAL_MS,
      );
    }

    // Collect immediately on startup, and aggregate if primary
    try {
      await this.collectAndStoreCurrentHashrate();
      if (this.isPrimaryInstance) {
        await this.aggregateInstanceData();
      }
    } catch (error) {
      console.error('[LiveHashrate] Error on initial startup:', error);
    }

    console.log(`[LiveHashrate] Instance ${this.instanceId} initialized`);
  }

  async onModuleDestroy() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
    }

    if (this.redis) {
      await this.redis.disconnect();
    }

    console.log(`[LiveHashrate] Instance ${this.instanceId} shutdown`);
  }



  /**
   * Aggregate data from all instances into final hashrate values
   * Finds all timestamps with partial data and creates aggregated records
   *
   * OPTIMIZED: Single-pass SCAN with in-memory grouping to avoid nested SCAN loops
   * Only instance 0 aggregates - no need for distributed locking
   */
  private async aggregateInstanceData(): Promise<void> {
    // Only instance 0 aggregates - no need for distributed locking
    if (!this.isPrimaryInstance) return;
    if (!this.redis) return;

    console.log(`[LiveHashrate] Instance ${this.instanceId} starting aggregation`);
    this.aggregationMetrics.totalAggregations++;

    try {
      const now = Date.now();

      // OPTIMIZATION: Single SCAN to get all partial keys
      // Previously this caused nested SCAN loops (one scan per timestamp)
      const allPartialKeys = await this.scanKeys(`${this.INSTANCE_PREFIX}:*:addr:*:*`);

      // Group keys by timestamp IN MEMORY (no additional scans needed!)
      const keysByTimestamp = new Map<number, string[]>();
      for (const key of allPartialKeys) {
        try {
          // Parse key: livehash:i:0:addr:bc1qxyz:1702483260000
          const parts = key.split(':');
          if (parts.length >= 6) {
            const timestamp = parseInt(parts[parts.length - 1], 10);
            if (!Number.isNaN(timestamp) && now - timestamp < 3600000) {
              // Only process last hour
              if (!keysByTimestamp.has(timestamp)) {
                keysByTimestamp.set(timestamp, []);
              }
              keysByTimestamp.get(timestamp)!.push(key);
            }
          }
        } catch (err) {
          // Skip malformed keys
        }
      }

      // Aggregate for each timestamp using pre-grouped keys (no more scans!)
      let aggregatedCount = 0;
      for (const [timestamp, keys] of keysByTimestamp.entries()) {
        const aggregated = await this.aggregateForTimestamp(timestamp, keys);
        if (aggregated) {
          aggregatedCount++;
        }
      }

      this.aggregationMetrics.successfulAggregations++;
      this.aggregationMetrics.lastAggregationTime = Date.now();
    } catch (error) {
      this.aggregationMetrics.failedAggregations++;
      this.logAggregationError(`Aggregation failed: ${error}`);
    }
  }

  /**
   * Aggregate data from all instances for a specific 1-minute timestamp
   *
   * Reads partial data stored by each instance:
   *   livehash:i:{instanceId}:addr:{address}:{timestamp}
   *
   * Creates aggregated final data:
   *   livehash:addr:{address}:{timestamp}
   *   livehash:pool:{timestamp}
   *
   * This ensures:
   * - No duplicates: each instance's data counted once
   * - No gaps: only complete minutes are aggregated
   * - No missing: sum all instances for each address
   *
   * OPTIMIZED: Accepts pre-filtered keys to avoid redundant SCAN operations
   */
  private async aggregateForTimestamp(
    timestamp: number,
    partialKeys: string[]
  ): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const addressAggregates = new Map<string, {
        totalHashrate: number;
        instances: string[];
      }>();

      // OPTIMIZATION: Use pre-filtered keys from caller (no SCAN needed!)
      // Previously: await this.scanKeys(`${this.INSTANCE_PREFIX}:*:addr:*:${timestamp}`)
      const addressPartialKeys = partialKeys;

      // Sum up hashrates by address across all instances
      for (const partialKey of addressPartialKeys) {
        try {
          // Parse key: livehash:i:0:addr:bc1qxyz:1702483260000
          const parts = partialKey.split(':');
          if (parts.length < 6) continue;

          const instanceId = parts[2];
          const address = parts.slice(4, -1).join(':'); // Handle addresses with colons (shouldn't happen but be safe)

          const data = await this.redis.get(partialKey);
          if (!data) continue;

          const parsed = JSON.parse(data);
          const hashrate = parsed.hashrate ?? 0;

          if (!addressAggregates.has(address)) {
            addressAggregates.set(address, { totalHashrate: 0, instances: [] });
          }

          const agg = addressAggregates.get(address)!;
          agg.totalHashrate += hashrate;
          agg.instances.push(instanceId);
        } catch (err) {
          console.warn(`[LiveHashrate] Failed to parse partial key ${partialKey}:`, err);
        }
      }

      // Calculate pool total
      let poolTotalHashrate = 0;
      for (const agg of addressAggregates.values()) {
        poolTotalHashrate += agg.totalHashrate;
      }

      // Log addresses reported by multiple instances (expected for load-balanced addresses)
      let multiInstanceAddresses = 0;
      for (const [address, agg] of addressAggregates.entries()) {
        if (agg.instances.length > 1) {
          multiInstanceAddresses++;
          this.aggregationMetrics.deduplicatedAddresses++;
        }
      }

      // Write aggregated pool data
      const poolKey = `${this.POOL_PREFIX}:${timestamp}`;
      try {
        await this.redis.setEx(
          poolKey,
          this.RETENTION_SECONDS,
          JSON.stringify({
            hashrate: poolTotalHashrate,
            timestamp,
            addressCount: addressAggregates.size,
            aggregatedAt: Date.now(),
            multiInstanceAddressCount: multiInstanceAddresses
          }),
        );
      } catch (err) {
        console.error(`[LiveHashrate] Failed to write aggregated pool key ${poolKey}:`, err);
      }

      // Write aggregated address data
      for (const [address, agg] of addressAggregates.entries()) {
        const addrKey = `${this.ADDR_PREFIX}:${address}:${timestamp}`;
        try {
          await this.redis.setEx(
            addrKey,
            this.RETENTION_SECONDS,
            JSON.stringify({
              hashrate: agg.totalHashrate,
              timestamp,
              connectedInstances: agg.instances,
              instanceCount: agg.instances.length,
              aggregatedAt: Date.now(),
            }),
          );
        } catch (err) {
          console.error(`[LiveHashrate] Failed to write aggregated address key ${addrKey}:`, err);
        }
      }

      return true;
    } catch (error) {
      this.logAggregationError(`Failed to aggregate timestamp ${timestamp}: ${error}`);
      return false;
    }
  }


  /**
   * Log aggregation errors and track them for monitoring
   */
  private logAggregationError(message: string): void {
    console.error(`[LiveHashrate] ${message}`);
    this.aggregationMetrics.lastError = message;
  }

  /**
   * Get aggregation metrics for monitoring
   */
  public getAggregationMetrics(): typeof this.aggregationMetrics {
    return { ...this.aggregationMetrics };
  }

  /**
   * Collect hashrate for the PREVIOUS complete 1-minute slot
   * This ensures we have all submissions for that minute
   * Runs every 60 seconds, stores data with proper 1-minute boundary alignment
   */
  async collectAndStoreCurrentHashrate(): Promise<void> {
    if (!this.redis) {
      console.warn('[LiveHashrate] Redis unavailable, skipping collection');
      return;
    }

    try {
      const now = Date.now();

      // Calculate the PREVIOUS complete minute (not the current one)
      // e.g., if now is 1702483275300 (at 75.3 seconds), previous minute is 1702483200000-1702483260000
      // We store with key for the END time: 1702483260000
      const previousMinuteStart = (Math.floor(now / 60000) - 1) * 60000; // Start of previous minute
      const previousMinuteEnd = previousMinuteStart + 60000; // End of previous minute (slot timestamp)

      // Skip if we just started (would give us negative time)
      if (previousMinuteStart < 0) {
        console.log('[LiveHashrate] Skipping first minute collection');
        return;
      }

      const allAddresses = this.stratumV1Service.getAllAddresses();

      // Collect hashrate for each address in the previous minute
      const addressDifficulties = new Map<string, number>(); // Raw difficulty, not hashrate yet
      let poolTotalDifficulty = 0;

      for (const address of allAddresses) {
        const clientsForAddress = this.stratumV1Service.getClientsForAddress(address);
        let addressTotalDifficulty = 0;

        // Get submissions from all workers for this address in the previous minute
        for (const client of clientsForAddress) {
          const startDate = new Date(previousMinuteStart);
          const endDate = new Date(previousMinuteEnd);
          const submissions = client.getSubmissionCacheForInterval(startDate, endDate);

          if (submissions.length > 0) {
            const totalDifficulty = submissions.reduce(
              (sum, sub) => sum + (sub.difficulty ?? 0),
              0,
            );
            addressTotalDifficulty += totalDifficulty;
          }
        }

        if (addressTotalDifficulty > 0) {
          addressDifficulties.set(address, addressTotalDifficulty);
          poolTotalDifficulty += addressTotalDifficulty;
        }
      }

      // Convert total difficulty to hashrate: hashrate = (difficulty * 2^32) / seconds
      // With 60 seconds: hashrate = difficulty * 4294967296 / 60
      const poolHashrate = (poolTotalDifficulty * 4294967296) / 60;

      // Store PARTIAL data with this instance's ID (for later aggregation)
      // This way we can track which instance contributed what
      const instancePoolKey = `${this.INSTANCE_PREFIX}:${this.instanceId}:pool:${previousMinuteEnd}`;
      await this.redis.setEx(
        instancePoolKey,
        this.RETENTION_SECONDS,
        JSON.stringify({
          hashrate: poolHashrate,
          difficulty: poolTotalDifficulty,
          timestamp: previousMinuteEnd,
          instanceId: this.instanceId
        }),
      );

      // Store per-address PARTIAL data
      const addressHashrates: Record<string, number> = {};
      for (const [address, difficulty] of addressDifficulties.entries()) {
        const addressHashrate = (difficulty * 4294967296) / 60;
        const instanceAddrKey = `${this.INSTANCE_PREFIX}:${this.instanceId}:addr:${address}:${previousMinuteEnd}`;

        await this.redis.setEx(
          instanceAddrKey,
          this.RETENTION_SECONDS,
          JSON.stringify({
            hashrate: addressHashrate,
            difficulty,
            timestamp: previousMinuteEnd,
            address,
            instanceId: this.instanceId
          }),
        );

        addressHashrates[address] = addressHashrate;
      }
    } catch (error) {
      console.error('[LiveHashrate] Error during collection:', error);
      this.logAggregationError(`Collection failed: ${error}`);
    }
  }

  /**
   * Get aggregated pool-wide live hashrate for a time range
   * Reads from final aggregated data: livehash:pool:{timestamp}
   */
  async getPoolLiveHashrate(lookbackHours: number = 1): Promise<HashrateDataPoint[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const now = Date.now();
      const lookbackMs = lookbackHours * 3600 * 1000;

      // Align to 1-minute boundaries to match Redis key timestamps
      // Exclude current incomplete slot by going back one minute
      const alignedNow = Math.floor(now / 60000) * 60000 - 60000;
      const alignedStartTime = alignedNow - lookbackMs;

      // Get all aggregated pool keys within the time range
      // Pattern: livehash:pool:{timestamp}
      const keys = await this.scanKeys(`${this.POOL_PREFIX}:*`);
      const dataPoints: Array<{ label: number; data: number }> = [];

      for (const key of keys) {
        try {
          // Extract timestamp from key: livehash:pool:1702483260000
          const timestampStr = key.substring(this.POOL_PREFIX.length + 1);
          const timestamp = parseInt(timestampStr, 10);

          if (!Number.isNaN(timestamp) && timestamp >= alignedStartTime && timestamp <= alignedNow) {
            const data = await this.redis.get(key);
            if (data) {
              const parsed = JSON.parse(data);
              dataPoints.push({
                label: timestamp,
                data: parsed.hashrate ?? 0,
              });
            }
          }
        } catch (error) {
          console.warn(`[LiveHashrate] Error parsing pool key ${key}:`, error);
        }
      }

      // Sort by timestamp
      dataPoints.sort((a, b) => a.label - b.label);

      // Fill gaps with zeros for visualization
      return this.fillGaps(dataPoints, alignedStartTime, alignedNow, 60000);
    } catch (error) {
      console.error('[LiveHashrate] Error retrieving pool hashrate:', error);
      return [];
    }
  }

  /**
   * Get aggregated address-specific live hashrate for a time range
   * Reads from final aggregated data: livehash:addr:{address}:{timestamp}
   */
  async getAddressLiveHashrate(
    address: string,
    lookbackHours: number = 1,
  ): Promise<HashrateDataPoint[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const now = Date.now();
      const lookbackMs = lookbackHours * 3600 * 1000;

      // Align to 1-minute boundaries to match Redis key timestamps
      // Exclude current incomplete slot by going back one minute
      const alignedNow = Math.floor(now / 60000) * 60000 - 60000;
      const alignedStartTime = alignedNow - lookbackMs;

      // Get all aggregated address keys for this address
      // Pattern: livehash:addr:{address}:{timestamp}
      const keys = await this.scanKeys(`${this.ADDR_PREFIX}:${address}:*`);
      const dataPoints: Array<{ label: number; data: number }> = [];

      for (const key of keys) {
        try {
          // Extract timestamp from end of key
          const parts = key.split(':');
          if (parts.length >= 4) {
            const timestampStr = parts[parts.length - 1];
            const timestamp = parseInt(timestampStr, 10);

            if (!Number.isNaN(timestamp) && timestamp >= alignedStartTime && timestamp <= alignedNow) {
              const data = await this.redis.get(key);
              if (data) {
                const parsed = JSON.parse(data);
                dataPoints.push({
                  label: timestamp,
                  data: parsed.hashrate ?? 0,
                });
              }
            }
          }
        } catch (error) {
          console.warn(`[LiveHashrate] Error parsing address key for ${address}:`, error);
        }
      }

      // Sort by timestamp
      dataPoints.sort((a, b) => a.label - b.label);

      // Fill gaps with zeros for visualization
      return this.fillGaps(dataPoints, alignedStartTime, alignedNow, 60000);
    } catch (error) {
      console.error(`[LiveHashrate] Error retrieving address ${address} hashrate:`, error);
      return [];
    }
  }

  private fillGaps(
    dataPoints: Array<{ label: number; data: number }>,
    startTime: number,
    endTime: number,
    intervalMs: number,
  ): HashrateDataPoint[] {
    if (dataPoints.length === 0) {
      return [];
    }

    const filled: HashrateDataPoint[] = [];
    const pointMap = new Map(dataPoints.map((p) => [p.label, p.data]));

    for (let time = startTime; time <= endTime; time += intervalMs) {
      filled.push({
        label: new Date(time).toISOString(),
        data: pointMap.get(time) ?? 0,
      });
    }

    return filled;
  }
}
