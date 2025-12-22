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

interface InstanceStats {
  instanceId: string;
  timestamp: number;
  poolHashrate: number;
  addresses: Record<string, number>;
  isStale: boolean;
}

@Injectable()
export class LiveHashrateService implements OnModuleInit, OnModuleDestroy {
  private collectionInterval: NodeJS.Timeout;
  private heartbeatInterval: NodeJS.Timeout;
  private aggregationInterval: NodeJS.Timeout;
  private redis: RedisClientType;
  private instanceId: string;
  private readonly COLLECTION_INTERVAL_MS = 60000; // 60 seconds
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  private readonly AGGREGATION_INTERVAL_MS = 180000; // 3 minutes (reduced from 30s to prevent CPU spikes)
  private readonly AGGREGATION_LOCK_TTL_MS = 200000; // 200 seconds (longer than interval to prevent overlaps)
  private readonly RETENTION_HOURS = 24;
  private readonly RETENTION_SECONDS = this.RETENTION_HOURS * 3600;
  private readonly INSTANCE_TIMEOUT_MS = 120000; // 2 minutes - if no heartbeat, consider dead
  private readonly POOL_PREFIX = 'livehash:pool';
  private readonly ADDR_PREFIX = 'livehash:addr';
  private readonly INSTANCE_PREFIX = 'livehash:i';
  private readonly HEARTBEAT_PREFIX = 'livehash:hb';
  private readonly AGGREGATION_LOCK_KEY = 'livehash:agg:lock';
  private readonly SYNC_CHANNEL = 'livehash:sync';

  // Local tracking
  private instanceDataCache = new Map<string, InstanceStats>();
  private lastAggregationTime = 0;
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
    this.instanceId = process.env.NODE_APP_INSTANCE ?? '0';
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

        // Subscribe to cluster updates
        this.subscribeToClusterUpdates();
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

    // Start heartbeat to signal this instance is alive
    this.heartbeatInterval = setInterval(
      () => this.publishHeartbeat(),
      this.HEARTBEAT_INTERVAL_MS,
    );

    // Start aggregation job to combine data from all instances
    this.aggregationInterval = setInterval(
      () => this.aggregateInstanceData(),
      this.AGGREGATION_INTERVAL_MS,
    );

    // Collect and aggregate immediately on startup
    try {
      await this.collectAndStoreCurrentHashrate();
      await this.publishHeartbeat();
      await this.aggregateInstanceData();
    } catch (error) {
      console.error('[LiveHashrate] Error on initial startup:', error);
    }

    console.log(`[LiveHashrate] Instance ${this.instanceId} initialized`);
  }

  async onModuleDestroy() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
    }

    if (this.redis) {
      await this.redis.disconnect();
    }

    console.log(`[LiveHashrate] Instance ${this.instanceId} shutdown`);
  }

  private subscribeToClusterUpdates() {
    if (!this.redis) return;

    try {
      const subscriber = this.redis.duplicate();
      subscriber.subscribe(this.SYNC_CHANNEL, async (message: string) => {
        try {
          const update = JSON.parse(message);
          this.handleClusterUpdate(update);
        } catch (error) {
          this.logAggregationError(`Failed to process cluster update: ${error}`);
        }
      });
      console.log('[LiveHashrate] Subscribed to cluster updates on channel', this.SYNC_CHANNEL);
    } catch (error) {
      this.logAggregationError(`Failed to subscribe to cluster updates: ${error}`);
    }
  }

  /**
   * Handle incoming cluster updates from other PM2 instances
   * Stores instance data in local cache for later aggregation
   */
  private handleClusterUpdate(update: any) {
    try {
      if (!update.instanceId || !update.timestamp) {
        console.warn('[LiveHashrate] Received invalid cluster update:', update);
        return;
      }

      // Ignore our own messages
      if (update.instanceId === this.instanceId) {
        return;
      }

      // Store in instance cache
      const instanceStats: InstanceStats = {
        instanceId: update.instanceId,
        timestamp: update.timestamp,
        poolHashrate: update.pool ?? 0,
        addresses: update.addresses ?? {},
        isStale: false,
      };

      this.instanceDataCache.set(update.instanceId, instanceStats);
    } catch (error) {
      this.logAggregationError(`Error handling cluster update: ${error}`);
    }
  }

  /**
   * Publish this instance's hashrate data to the cluster
   */
  private async publishHeartbeat(): Promise<void> {
    if (!this.redis) return;

    try {
      const heartbeatKey = `${this.HEARTBEAT_PREFIX}:${this.instanceId}`;
      await this.redis.setEx(heartbeatKey, 300, JSON.stringify({ instanceId: this.instanceId, timestamp: Date.now() }));
    } catch (error) {
      this.logAggregationError(`Failed to publish heartbeat: ${error}`);
    }
  }

  /**
   * Try to acquire the aggregation lock
   * Only one PM2 instance should aggregate at a time to prevent CPU spikes
   * @returns true if lock was acquired, false otherwise
   */
  private async tryAcquireAggregationLock(): Promise<boolean> {
    if (!this.redis) return false;

    try {
      // Use SET with NX (only set if not exists) and PX (milliseconds expiry)
      const result = await this.redis.set(
        this.AGGREGATION_LOCK_KEY,
        this.instanceId,
        {
          NX: true, // Only set if key doesn't exist
          PX: this.AGGREGATION_LOCK_TTL_MS, // Auto-expire after TTL
        }
      );

      // SET returns 'OK' if successful, null if key already exists
      return result === 'OK';
    } catch (error) {
      console.error('[LiveHashrate] Failed to acquire aggregation lock:', error);
      return false;
    }
  }

  /**
   * Release the aggregation lock
   * Should be called after aggregation completes
   */
  private async releaseAggregationLock(): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.del(this.AGGREGATION_LOCK_KEY);
      console.log(`[LiveHashrate] Instance ${this.instanceId} released aggregation lock`);
    } catch (error) {
      console.error('[LiveHashrate] Failed to release aggregation lock:', error);
    }
  }

  /**
   * Aggregate data from all instances into final hashrate values
   * Finds all timestamps with partial data and creates aggregated records
   *
   * OPTIMIZED: Single-pass SCAN with in-memory grouping to avoid nested SCAN loops
   * OPTIMIZED: Only one PM2 instance aggregates at a time using Redis lock
   */
  private async aggregateInstanceData(): Promise<void> {
    if (!this.redis) return;

    // Try to acquire lock - if another instance is aggregating, skip
    const lockAcquired = await this.tryAcquireAggregationLock();
    if (!lockAcquired) {
      console.log(`[LiveHashrate] Instance ${this.instanceId} skipping aggregation (another instance holds the lock)`);
      return;
    }

    console.log(`[LiveHashrate] Instance ${this.instanceId} acquired aggregation lock`);
    this.aggregationMetrics.totalAggregations++;

    try {
      const now = Date.now();

      // Clean up stale instances (no heartbeat for > INSTANCE_TIMEOUT_MS)
      await this.cleanupStaleInstances();

      // Get all instance heartbeats to identify active instances
      const activeInstances = await this.getActiveInstances();

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
        const aggregated = await this.aggregateForTimestamp(timestamp, keys, activeInstances);
        if (aggregated) {
          aggregatedCount++;
        }
      }

      this.aggregationMetrics.successfulAggregations++;
      this.aggregationMetrics.lastAggregationTime = Date.now();
    } catch (error) {
      this.aggregationMetrics.failedAggregations++;
      this.logAggregationError(`Aggregation failed: ${error}`);
    } finally {
      // CRITICAL: Always release the lock, even if aggregation failed
      await this.releaseAggregationLock();
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
    partialKeys: string[],
    activeInstances: Set<string>
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
            activeInstances: Array.from(activeInstances),
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
   * Get all active instances based on recent heartbeats
   */
  private async getActiveInstances(): Promise<Set<string>> {
    if (!this.redis) return new Set([this.instanceId]);

    try {
      const heartbeatKeys = await this.scanKeys(`${this.HEARTBEAT_PREFIX}:*`);
      const activeInstances = new Set<string>();

      for (const key of heartbeatKeys) {
        const instanceId = key.substring(this.HEARTBEAT_PREFIX.length + 1);
        activeInstances.add(instanceId);
      }

      // Always include this instance
      activeInstances.add(this.instanceId);

      return activeInstances;
    } catch (error) {
      this.logAggregationError(`Failed to get active instances: ${error}`);
      return new Set([this.instanceId]);
    }
  }

  /**
   * Clean up instances that haven't sent a heartbeat recently
   */
  private async cleanupStaleInstances(): Promise<void> {
    if (!this.redis) return;

    try {
      const now = Date.now();
      const staleInstanceIds: string[] = [];

      for (const [instanceId, instanceStats] of this.instanceDataCache.entries()) {
        if (now - instanceStats.timestamp > this.INSTANCE_TIMEOUT_MS) {
          if (!instanceStats.isStale) {
            instanceStats.isStale = true;
            staleInstanceIds.push(instanceId);
            this.aggregationMetrics.droppedStaleInstances++;
            console.warn(
              `[LiveHashrate] Marked instance ${instanceId} as stale (no update for ${Math.round((now - instanceStats.timestamp) / 1000)}s)`,
            );
          }
        }
      }

      // Remove instances that have been stale for more than 5 minutes
      for (const instanceId of this.instanceDataCache.keys()) {
        const instanceStats = this.instanceDataCache.get(instanceId);
        if (instanceStats?.isStale && now - instanceStats.timestamp > 300000) {
          // 5 minutes
          this.instanceDataCache.delete(instanceId);
          console.log(`[LiveHashrate] Removed completely stale instance ${instanceId}`);
        }
      }
    } catch (error) {
      this.logAggregationError(`Failed to cleanup stale instances: ${error}`);
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

      // Publish to cluster for real-time updates
      await this.publishHashrateUpdate(previousMinuteEnd, poolHashrate, addressHashrates);
    } catch (error) {
      console.error('[LiveHashrate] Error during collection:', error);
      this.logAggregationError(`Collection failed: ${error}`);
    }
  }

  private async publishHashrateUpdate(
    timestamp: number,
    poolHashrate: number,
    addresses: Record<string, number>,
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const message = JSON.stringify({
        type: 'update',
        instanceId: this.instanceId,
        timestamp,
        pool: poolHashrate,
        addresses,
      });

      await this.redis.publish(this.SYNC_CHANNEL, message);
    } catch (error) {
      this.logAggregationError(`Failed to publish cluster update: ${error}`);
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
