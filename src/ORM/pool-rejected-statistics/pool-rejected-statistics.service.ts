import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Mutex } from 'async-mutex';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';

@Injectable()
export class PoolRejectedStatisticsService implements OnModuleInit {
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
        console.log('[PoolRejectedStatisticsService] Using Redis for atomic share increments');
      } else {
        throw new Error('Redis not available - required for pool rejected statistics');
      }
    } catch (error) {
      console.error('[PoolRejectedStatisticsService] Failed to access Redis client:', error);
      throw error;
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

  public async addRejectedShare(reason: string, diff: number): Promise<boolean> {
    return await this.mutex.runExclusive(async () => {
      const coeff = 1000 * 60 * 10;
      const now = Date.now();
      // Time slot labeled by END time (e.g., slot "20:50" contains data from 20:40-20:50)
      const timeSlot = Math.floor(now / coeff) * coeff + coeff;

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

      // Atomically increment count for this reason in Redis
      const key = `pool:rejected:${timeSlot}`;
      await this.redisClient.hIncrByFloat(key, reason, diff);

      // Set expiry on key (24 hours)
      await this.redisClient.expire(key, 86400);

      return true;
    });
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
