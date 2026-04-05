import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';
import { DIFFICULTY_1, REDIS_STATISTICS_TTL } from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

@Injectable()
export class PoolShareStatisticsService implements OnModuleInit {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private redisClient: any = null;

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        console.log('[PoolShareStatisticsService] Using Redis for atomic share increments');
      } else {
        console.error('[PoolShareStatisticsService] Redis not available - shares will not be tracked!');
      }
    } catch (error) {
      console.error('[PoolShareStatisticsService] Failed to access Redis client:', error);
    }
  }

  private async handleShare(accepted: number, rejected: number) {
    if (!Number.isFinite(accepted) || !Number.isFinite(rejected)) {
      console.warn(
        `discarded non-finite share stats: accepted=${accepted}, rejected=${rejected}`,
      );
      return;
    }

    if (!this.redisClient) {
      console.error('[PoolShareStatisticsService] Cannot track share - Redis not available');
      return;
    }

    const timeSlot = TimeSlotHelper.getCurrentSlot();
    const key = `pool:shares:${timeSlot}`;

    // Atomically increment accepted/rejected shares
    const promises: Promise<any>[] = [];
    if (accepted > 0) {
      promises.push(this.redisClient.hIncrByFloat(key, 'accepted', accepted));
    }
    if (rejected > 0) {
      promises.push(this.redisClient.hIncrByFloat(key, 'rejected', rejected));
    }
    promises.push(this.redisClient.expire(key, REDIS_STATISTICS_TTL));
    await Promise.all(promises);
  }

  private async addShares(accepted: number, rejected: number) {
    await this.handleShare(accepted, rejected);
  }

  public async addAcceptedShare(difficulty: number) {
    await this.addShares(difficulty, 0);
  }

  public async addRejectedShare(difficulty: number) {
    await this.addShares(0, difficulty);
  }

  public async insert(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.insert(stat);
  }

  public async update(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.update(
      { time: stat.time },
      {
        accepted: stat.accepted,
        rejected: stat.rejected,
        updatedAt: new Date(),
      },
    );
  }

  public async getTotalsSince(
    time: number,
  ): Promise<{ accepted: number; rejected: number }> {
    const result = await this.poolShareStatisticsRepository
      .createQueryBuilder('stat')
      .select('SUM(stat.accepted)', 'accepted')
      .addSelect('SUM(stat.rejected)', 'rejected')
      .where('stat.time > :time', { time })
      .getRawOne();
    return {
      accepted: result?.accepted ? parseFloat(result.accepted) : 0,
      rejected: result?.rejected ? parseFloat(result.rejected) : 0,
    };
  }

  public async getEntriesSince(
    time: number,
  ): Promise<PoolShareStatisticsEntity[]> {
    return this.poolShareStatisticsRepository.find({
      where: { time: MoreThan(time) },
      order: { time: 'ASC' },
    });
  }
}
