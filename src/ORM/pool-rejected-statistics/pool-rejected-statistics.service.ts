import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';

@Injectable()
export class PoolRejectedStatisticsService implements OnModuleInit {
  constructor(
    @InjectRepository(PoolRejectedStatisticsEntity)
    private poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private redisClient: any = null;

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

  public async addRejectedShare(reason: string, diff: number): Promise<void> {
    const coeff = 1000 * 60 * 10;
    const now = Date.now();
    // Time slot labeled by END time (e.g., slot "20:50" contains data from 20:40-20:50)
    const timeSlot = Math.floor(now / coeff) * coeff + coeff;

    // Atomically increment count for this reason in Redis
    const key = `pool:rejected:${timeSlot}`;
    await Promise.all([
      this.redisClient.hIncrByFloat(key, reason, diff),
      this.redisClient.expire(key, 86400),
    ]);
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

  public async deleteOlderThan(cutoff: number) {
    return this.poolRejectedStatisticsRepository
      .createQueryBuilder()
      .delete()
      .where('time < :cutoff', { cutoff })
      .execute();
  }

  public async getEntriesSince(time: number): Promise<PoolRejectedStatisticsEntity[]> {
    return this.poolRejectedStatisticsRepository.find({
      where: { time: MoreThan(time) },
      order: { time: 'ASC' },
    });
  }
}
