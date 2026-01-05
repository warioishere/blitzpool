import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';

@Injectable()
export class ClientRejectedStatisticsService implements OnModuleInit {
  constructor(
    @InjectRepository(ClientRejectedStatisticsEntity)
    private clientRejectedStatisticsRepository: Repository<ClientRejectedStatisticsEntity>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private redisClient: any = null;

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        console.log('[ClientRejectedStatisticsService] Using Redis for atomic increments');
      } else {
        console.error('[ClientRejectedStatisticsService] Redis not available - client rejected statistics will not be tracked!');
      }
    } catch (error) {
      console.error('[ClientRejectedStatisticsService] Failed to access Redis client:', error);
    }
  }

  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10;
    // Time slot labeled by END time (e.g., slot "20:50" contains data from 20:40-20:50)
    return Math.floor(Date.now() / coeff) * coeff + coeff;
  }

  public async addRejectedShare(address: string, reason: string, diff: number) {
    if (!this.redisClient) {
      console.error('[ClientRejectedStatisticsService] Cannot track reject - Redis not available');
      return;
    }

    const timeSlot = this.getTimeSlot();
    const key = `client:rejected:${address}:${timeSlot}`;

    // Atomically increment count and shares for this reason
    // shares = sum of (diff - 1) values
    await this.redisClient.hIncrBy(key, `${reason}:count`, 1);
    await this.redisClient.hIncrByFloat(key, `${reason}:shares`, Math.max(0, diff - 1));

    // Set expiry on key (24 hours)
    await this.redisClient.expire(key, 86400);
  }

  public async getTotalsSince(
    address: string,
    time: number,
  ): Promise<Record<string, { count: number; shares: number }>> {
    const query = this.clientRejectedStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.reason', 'reason')
      .addSelect('SUM(stat.count)', 'count')
      .addSelect('SUM(stat.shares)', 'shares')
      .where('stat.time > :time', { time })
      .andWhere('stat.address = :address', { address })
      .groupBy('stat.reason');
    const result = await query.getRawMany();

    const totals: Record<string, { count: number; shares: number }> = {};
    result.forEach(r => {
      totals[r.reason] = {
        count: r.count ? parseFloat(r.count) : 0,
        shares: r.shares ? parseFloat(r.shares) : 0,
      };
    });
    return totals;
  }

  public async getEntriesSince(address: string, time: number): Promise<ClientRejectedStatisticsEntity[]> {
    return this.clientRejectedStatisticsRepository.find({
      where: { address, time: MoreThan(time) },
      order: { time: 'ASC' },
    });
  }
}
