import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { StratumV1Service } from './stratum-v1.service';
import { StratumV2Service } from './stratum-v2.service';
import { createClient, RedisClientType } from 'redis';

export interface HashrateDataPoint {
  label: string;
  data: number;
}

@Injectable()
export class LiveHashrateService implements OnModuleInit, OnModuleDestroy {
  private collectionInterval: NodeJS.Timeout;
  private redis: RedisClientType;
  private readonly COLLECTION_INTERVAL_MS = 60000; // 60 seconds
  private readonly RETENTION_HOURS = 24;
  private readonly RETENTION_SECONDS = this.RETENTION_HOURS * 3600;
  private readonly POOL_PREFIX = 'livehash:pool';
  private readonly ADDR_PREFIX = 'livehash:addr';

  constructor(
    private readonly stratumV1Service: StratumV1Service,
    private readonly stratumV2Service: StratumV2Service,
    private readonly configService: ConfigService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
  ) {}

  /**
   * Scan Redis keys using cursor-based iteration (non-blocking)
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    if (!this.redis) return [];

    const keys: string[] = [];
    let cursor = 0;

    try {
      do {
        const result = await this.redis.scan(cursor, {
          MATCH: pattern,
          COUNT: 1000,
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

        // Clean up stale instance-specific keys from old multi-instance setup
        await this.cleanupLegacyInstanceKeys();
      } catch (error) {
        console.error('[LiveHashrate] Failed to connect to Redis:', error);
      }
    } else {
      console.warn('[LiveHashrate] Redis not configured - live hashrate will not persist');
    }

    this.collectionInterval = setInterval(
      () => this.collectAndStoreCurrentHashrate(),
      this.COLLECTION_INTERVAL_MS,
    );

    // Collect immediately on startup
    try {
      await this.collectAndStoreCurrentHashrate();
    } catch (error) {
      console.error('[LiveHashrate] Error on initial startup:', error);
    }

    console.log('[LiveHashrate] Initialized');
  }

  async onModuleDestroy() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }

    if (this.redis) {
      await this.redis.disconnect();
    }

    console.log('[LiveHashrate] Shutdown');
  }

  /**
   * Remove leftover livehash:i:* keys from the old multi-instance architecture.
   * Runs once on startup — these keys have TTLs so this is just a fast cleanup.
   */
  private async cleanupLegacyInstanceKeys(): Promise<void> {
    try {
      const legacyKeys = await this.scanKeys('livehash:i:*');
      if (legacyKeys.length > 0) {
        // Delete in batches of 100
        for (let i = 0; i < legacyKeys.length; i += 100) {
          const batch = legacyKeys.slice(i, i + 100);
          await this.redis.del(batch);
        }
        console.log(`[LiveHashrate] Cleaned up ${legacyKeys.length} legacy instance keys`);
      }
    } catch (error) {
      console.warn('[LiveHashrate] Failed to clean up legacy keys:', error);
    }
  }

  /**
   * Collect hashrate for the PREVIOUS complete 1-minute slot and store directly
   * as final pool/address data. Runs every 60 seconds.
   */
  async collectAndStoreCurrentHashrate(): Promise<void> {
    if (!this.redis) {
      console.warn('[LiveHashrate] Redis unavailable, skipping collection');
      return;
    }

    try {
      const now = Date.now();

      // Calculate the PREVIOUS complete minute
      const previousMinuteStart = (Math.floor(now / 60000) - 1) * 60000;
      const previousMinuteEnd = previousMinuteStart + 60000;

      if (previousMinuteStart < 0) {
        console.log('[LiveHashrate] Skipping first minute collection');
        return;
      }

      // Merge addresses from both V1 and V2 services
      const v1Addresses = this.stratumV1Service.getAllAddresses();
      const v2Addresses = this.stratumV2Service.getAllAddresses();
      const allAddresses = [...new Set([...v1Addresses, ...v2Addresses])];

      // Collect difficulty for each address in the previous minute
      let poolTotalDifficulty = 0;
      const startDate = new Date(previousMinuteStart);
      const endDate = new Date(previousMinuteEnd);

      const pipeline = this.redis.multi();
      let addressCount = 0;

      for (const address of allAddresses) {
        let addressTotalDifficulty = 0;

        // V1 clients
        for (const client of this.stratumV1Service.getClientsForAddress(address)) {
          const submissions = client.getSubmissionCacheForInterval(startDate, endDate);
          for (const sub of submissions) {
            addressTotalDifficulty += sub.difficulty ?? 0;
          }
        }

        // V2 clients
        for (const client of this.stratumV2Service.getClientsForAddress(address)) {
          const submissions = client.getSubmissionCacheForInterval(startDate, endDate);
          for (const sub of submissions) {
            addressTotalDifficulty += sub.difficulty ?? 0;
          }
        }

        if (addressTotalDifficulty > 0) {
          const addressHashrate = (addressTotalDifficulty * 4294967296) / 60;
          poolTotalDifficulty += addressTotalDifficulty;
          addressCount++;

          pipeline.setEx(
            `${this.ADDR_PREFIX}:${address}:${previousMinuteEnd}`,
            this.RETENTION_SECONDS,
            JSON.stringify({ hashrate: addressHashrate, timestamp: previousMinuteEnd }),
          );
        }
      }

      // Store pool total
      const poolHashrate = (poolTotalDifficulty * 4294967296) / 60;
      pipeline.setEx(
        `${this.POOL_PREFIX}:${previousMinuteEnd}`,
        this.RETENTION_SECONDS,
        JSON.stringify({ hashrate: poolHashrate, timestamp: previousMinuteEnd, addressCount }),
      );

      await pipeline.exec();
    } catch (error) {
      console.error('[LiveHashrate] Error during collection:', error);
    }
  }

  /**
   * Get pool-wide live hashrate for a time range
   */
  async getPoolLiveHashrate(lookbackHours: number = 1): Promise<HashrateDataPoint[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const now = Date.now();
      const lookbackMs = lookbackHours * 3600 * 1000;

      const alignedNow = Math.floor(now / 60000) * 60000 - 60000;
      const alignedStartTime = alignedNow - lookbackMs;

      const keys = await this.scanKeys(`${this.POOL_PREFIX}:*`);
      const dataPoints: Array<{ label: number; data: number }> = [];

      const validKeys: string[] = [];
      const validTimestamps: number[] = [];
      for (const key of keys) {
        const timestampStr = key.substring(this.POOL_PREFIX.length + 1);
        const timestamp = parseInt(timestampStr, 10);
        if (!Number.isNaN(timestamp) && timestamp >= alignedStartTime && timestamp <= alignedNow) {
          validKeys.push(key);
          validTimestamps.push(timestamp);
        }
      }

      if (validKeys.length > 0) {
        const values = await this.redis.mGet(validKeys);
        for (let i = 0; i < validKeys.length; i++) {
          try {
            if (values[i]) {
              const parsed = JSON.parse(values[i]);
              dataPoints.push({ label: validTimestamps[i], data: parsed.hashrate ?? 0 });
            }
          } catch (error) {
            console.warn(`[LiveHashrate] Error parsing pool key ${validKeys[i]}:`, error);
          }
        }
      }

      dataPoints.sort((a, b) => a.label - b.label);
      return this.fillGaps(dataPoints, alignedStartTime, alignedNow, 60000);
    } catch (error) {
      console.error('[LiveHashrate] Error retrieving pool hashrate:', error);
      return [];
    }
  }

  /**
   * Get address-specific live hashrate for a time range
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

      const alignedNow = Math.floor(now / 60000) * 60000 - 60000;
      const alignedStartTime = alignedNow - lookbackMs;

      const keys = await this.scanKeys(`${this.ADDR_PREFIX}:${address}:*`);
      const dataPoints: Array<{ label: number; data: number }> = [];

      const validKeys: string[] = [];
      const validTimestamps: number[] = [];
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 4) {
          const timestamp = parseInt(parts[parts.length - 1], 10);
          if (!Number.isNaN(timestamp) && timestamp >= alignedStartTime && timestamp <= alignedNow) {
            validKeys.push(key);
            validTimestamps.push(timestamp);
          }
        }
      }

      if (validKeys.length > 0) {
        const values = await this.redis.mGet(validKeys);
        for (let i = 0; i < validKeys.length; i++) {
          try {
            if (values[i]) {
              const parsed = JSON.parse(values[i]);
              dataPoints.push({ label: validTimestamps[i], data: parsed.hashrate ?? 0 });
            }
          } catch (error) {
            console.warn(`[LiveHashrate] Error parsing address key for ${address}:`, error);
          }
        }
      }

      dataPoints.sort((a, b) => a.label - b.label);
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
