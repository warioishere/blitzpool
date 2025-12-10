import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Mutex } from 'async-mutex';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';

@Injectable()
export class PoolRejectedStatisticsService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @InjectRepository(PoolRejectedStatisticsEntity)
    private poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    const configValue = this.configService.get<string>(
      'ANOMALOUS_DIFF_DETECTION_ENABLED',
      'true',
    );
    this.anomalousDiffDetectionEnabled = !['false', '0', 'off', 'no'].includes(
      configValue?.toString().toLowerCase() ?? 'true',
    );
  }

  private mutex = new Mutex();
  private redisClient: any = null;
  private useRedis: boolean = false;

  // Fallback in-memory state
  private currentTimeSlot: number = null;
  private lastSave: number = null;
  private counts: Map<string, number> = new Map();

  // Anomaly detection state (per-worker, doesn't need to be shared)
  private recentDiffs: Map<string, number[]> = new Map();
  private readonly anomalousDiffDetectionEnabled: boolean;
  private static readonly buckets = [
    { label: '<10', lower: 0, upper: 10 },
    { label: '10-1k', lower: 10, upper: 1000 },
    { label: '1k-50k', lower: 1000, upper: 50000 },
    { label: '50k-250k', lower: 50000, upper: 250000 },
    { label: '250k-1M', lower: 250000, upper: 1000000 },
    { label: '>=1M', lower: 1000000, upper: Infinity },
  ];

  private lastBuckets: Map<string, string> = new Map();

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
        console.log('[PoolRejectedStatisticsService] Using Redis for shared state across PM2 workers');

        // Flush any stale pool:rejected:* keys to database on startup, then clean up
        try {
          const staleKeys = await this.redisClient.keys('pool:rejected:*');
          if (staleKeys && staleKeys.length > 0) {
            console.log(`[PoolRejectedStatisticsService] Found ${staleKeys.length} stale Redis keys on startup, flushing to database first`);
            await this.mutex.runExclusive(async () => {
              await this.saveCurrent();
            });
            console.log(`[PoolRejectedStatisticsService] Stale keys flushed and cleaned up successfully`);
          }
        } catch (redisError) {
          console.warn('[PoolRejectedStatisticsService] Failed to flush stale Redis keys on startup:', redisError);
        }
      } else {
        console.log('[PoolRejectedStatisticsService] Redis not available, using in-memory state');
      }
    } catch (error) {
      console.warn('[PoolRejectedStatisticsService] Failed to access Redis client, using in-memory state:', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    console.log('[PoolRejectedStatisticsService] Flushing pending rejected shares to database before shutdown...');
    try {
      if (this.currentTimeSlot != null) {
        await this.mutex.runExclusive(async () => {
          await this.saveCurrent();
        });
      }
      console.log('[PoolRejectedStatisticsService] Flush on shutdown completed successfully');
    } catch (error) {
      console.error('[PoolRejectedStatisticsService] Failed to flush on shutdown:', error);
    }
  }

  private getBucket(diff: number, reason: string): string {
    let idx = PoolRejectedStatisticsService.buckets.findIndex(
      b => diff >= b.lower && diff < b.upper,
    );
    if (idx === -1) {
      idx = PoolRejectedStatisticsService.buckets.length - 1;
    }

    const last = this.lastBuckets.get(reason);
    if (last) {
      let lastIdx = PoolRejectedStatisticsService.buckets.findIndex(
        b => b.label === last,
      );
      if (lastIdx === -1) {
        lastIdx = idx;
      }

      while (
        lastIdx < PoolRejectedStatisticsService.buckets.length - 1 &&
        diff >=
          PoolRejectedStatisticsService.buckets[lastIdx].upper * 1.1
      ) {
        lastIdx++;
      }
      while (
        lastIdx > 0 &&
        diff <=
          PoolRejectedStatisticsService.buckets[lastIdx].lower * 0.9
      ) {
        lastIdx--;
      }
      idx = lastIdx;
    }

    const bucket = PoolRejectedStatisticsService.buckets[idx].label;
    this.lastBuckets.set(reason, bucket);
    return bucket;
  }

  @Interval(60 * 1000)
  private async flushInterval() {
    await this.mutex.runExclusive(async () => {
      await this.saveCurrent();
      this.lastSave = Date.now();
    });
  }

  public async addRejectedShare(reason: string, diff: number): Promise<boolean> {
    return await this.mutex.runExclusive(async () => {
      const coeff = 1000 * 60 * 10;
      const now = Date.now();
      const timeSlot = Math.floor(now / coeff) * coeff;

      // Anomaly detection (per-worker, in-memory)
      if (this.anomalousDiffDetectionEnabled) {
        const bucket = this.getBucket(diff, reason);
        const key = `${reason}:${bucket}`;
        let history = this.recentDiffs.get(key) || [];
        if (history.length > 0) {
          const avg = history.reduce((sum, d) => sum + d, 0) / history.length;
          if (avg > 0 && diff > avg * 4) {
            history.push(diff);
            if (history.length > 20) {
              history.shift();
            }
            this.recentDiffs.set(key, history);
            console.warn(
              `Anomalous diff ${diff} for reason ${reason} (avg ${avg})`,
            );
            return false;
          }
        }

        history.push(diff);
        if (history.length > 20) {
          history.shift();
        }
        this.recentDiffs.set(key, history);
      }

      if (this.useRedis && this.redisClient) {
        // Redis-backed implementation
        const key = `pool:rejected:${timeSlot}`;

        // Atomically increment count for this reason
        await this.redisClient.hIncrByFloat(key, reason, diff);

        // Set expiry on key (24 hours)
        await this.redisClient.expire(key, 86400);
      } else {
        // Fallback in-memory implementation
        if (this.currentTimeSlot == null) {
          this.currentTimeSlot = timeSlot;
          this.counts.clear();
          this.lastSave = now;
        }

        if (this.currentTimeSlot !== timeSlot) {
          await this.saveCurrent();
          this.currentTimeSlot = timeSlot;
          this.counts.clear();
          this.lastSave = now;
        }

        const current = this.counts.get(reason) || 0;
        this.counts.set(reason, current + diff);

        if (now - this.lastSave > 60 * 1000) {
          await this.saveCurrent();
          this.lastSave = now;
        }
      }

      return true;
    });
  }

  private async saveCurrent() {
    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation with atomic claim-and-fetch
      const pattern = 'pool:rejected:*';
      const allKeys = await this.redisClient.keys(pattern);

      if (!allKeys || allKeys.length === 0) return;

      // Filter out processing locks to avoid WRONGTYPE errors
      const dataKeys = allKeys.filter(key => !key.endsWith(':processing'));

      for (const key of dataKeys) {
        // Atomically claim this key for processing using Lua script
        // This prevents multiple workers from processing the same key
        const claimScript = `
          local key = KEYS[1]
          local lockKey = key .. ':processing'
          local acquired = redis.call('SET', lockKey, '1', 'NX', 'EX', 10)
          if acquired then
            local data = redis.call('HGETALL', key)
            redis.call('DEL', key)
            return data
          else
            return nil
          end
        `;

        let data: any;
        try {
          const result = await this.redisClient.eval(claimScript, {
            keys: [key],
          });

          if (!result || result.length === 0) {
            // Another worker is processing this key or it's already been processed
            continue;
          }

          // Convert array result to object (Redis HGETALL returns [key1, val1, key2, val2, ...])
          data = {};
          for (let i = 0; i < result.length; i += 2) {
            data[result[i]] = result[i + 1];
          }
        } catch (claimError) {
          console.warn(`[PoolRejectedStatisticsService] Failed to claim key ${key}:`, claimError);
          continue;
        }

        if (!data || Object.keys(data).length === 0) {
          await this.redisClient.del(`${key}:processing`);
          continue;
        }

        // Extract timeSlot from key (pool:rejected:1234567890)
        const timeSlot = parseInt(key.split(':')[2]);

        const values = Object.entries(data)
          .map(([reason, count]) => ({
            time: timeSlot,
            reason,
            count: parseFloat(count as string),
          }))
          .filter(v => v.count > 0);

        if (values.length === 0) {
          await this.redisClient.del(`${key}:processing`);
          continue;
        }

        try {
          await this.poolRejectedStatisticsRepository
            .createQueryBuilder()
            .insert()
            .into(PoolRejectedStatisticsEntity)
            .values(values)
            .onConflict(
              '("time", "reason") DO UPDATE SET "count" = "count" + EXCLUDED."count", "updatedAt" = :updatedAt',
            )
            .setParameters({ updatedAt: new Date() })
            .execute();

          // Delete the processing lock after successful flush
          await this.redisClient.del(`${key}:processing`);
        } catch (error: any) {
          // Suppress TypeORM entity ID mapping errors on upsert - the data is persisted despite the error
          if (error?.message?.includes('entity id is not set')) {
            await this.redisClient.del(`${key}:processing`);
            return; // Data was successfully persisted
          }
          console.error(`[PoolRejectedStatisticsService] Failed to flush timeSlot ${timeSlot}:`, error);
          // On error, restore the data to Redis and remove lock
          try {
            await this.redisClient.hSet(key, data);
            await this.redisClient.del(`${key}:processing`);
          } catch (restoreError) {
            console.error(`[PoolRejectedStatisticsService] Failed to restore data to Redis:`, restoreError);
          }
        }
      }
    } else {
      // Fallback in-memory implementation
      if (this.counts.size === 0) {
        return;
      }

      const values = Array.from(this.counts.entries())
        .filter(([, delta]) => delta !== 0)
        .map(([reason, delta]) => ({
          time: this.currentTimeSlot,
          reason,
          count: delta,
        }));

      if (values.length === 0) {
        this.counts.clear();
        return;
      }

      try {
        await this.poolRejectedStatisticsRepository
          .createQueryBuilder()
          .insert()
          .into(PoolRejectedStatisticsEntity)
          .values(values)
          .onConflict(
            '("time", "reason") DO UPDATE SET "count" = "count" + EXCLUDED."count", "updatedAt" = :updatedAt',
          )
          .setParameters({ updatedAt: new Date() })
          .execute();
      } catch (error: any) {
        // Suppress TypeORM entity ID mapping errors on upsert - the data is persisted despite the error
        if (!error?.message?.includes('entity id is not set')) {
          throw error;
        }
        // Data was successfully persisted despite the TypeORM error
      }

      this.counts.clear();
    }
  }

  public async getTotalsSince(time: number): Promise<Record<string, number>> {
    const result = await this.poolRejectedStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.reason', 'reason')
      .addSelect('SUM(stat.count)', 'count')
      .where('stat.time > :time', { time })
      .groupBy('stat.reason')
      .getRawMany();

    const totals: Record<string, number> = {};
    result.forEach(r => {
      totals[r.reason] = r.count ? parseFloat(r.count) : 0;
    });
    return totals;
  }

  public async getEntriesSince(time: number): Promise<PoolRejectedStatisticsEntity[]> {
    return this.poolRejectedStatisticsRepository.find({
      where: { time: MoreThan(time) },
      order: { time: 'ASC' },
    });
  }
}
