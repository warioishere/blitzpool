import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Mutex } from 'async-mutex';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';

@Injectable()
export class PoolShareStatisticsService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private mutex = new Mutex();
  private redisClient: any = null;
  private useRedis: boolean = false;

  // Fallback in-memory state
  private currentTimeSlot: number = null;
  private accepted = 0;
  private rejected = 0;

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        this.useRedis = true;
        console.log('[PoolShareStatisticsService] Using Redis for shared state across PM2 workers');

        // Clear stale pool:shares:* keys on startup to prevent entity ID mapping errors
        try {
          const staleKeys = await this.redisClient.keys('pool:shares:*');
          if (staleKeys && staleKeys.length > 0) {
            console.log(`[PoolShareStatisticsService] Cleaning up ${staleKeys.length} stale Redis keys on startup`);
            await this.redisClient.del(...staleKeys);
          }
        } catch (redisError) {
          console.warn('[PoolShareStatisticsService] Failed to clean stale Redis keys on startup:', redisError);
        }
      } else {
        console.log('[PoolShareStatisticsService] Redis not available, using in-memory state');
      }
    } catch (error) {
      console.warn('[PoolShareStatisticsService] Failed to access Redis client, using in-memory state:', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    console.log('[PoolShareStatisticsService] Flushing pending shares to database before shutdown...');
    try {
      await this.flush();
      console.log('[PoolShareStatisticsService] Flush on shutdown completed successfully');
    } catch (error) {
      console.error('[PoolShareStatisticsService] Failed to flush on shutdown:', error);
    }
  }

  @Interval(60 * 1000)
  private async flushInterval() {
    await this.flush();
  }

  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10;
    return Math.floor(Date.now() / coeff) * coeff;
  }

  private async handleShare(accepted: number, rejected: number) {
    if (!Number.isFinite(accepted) || !Number.isFinite(rejected)) {
      console.warn(
        `discarded non-finite share stats: accepted=${accepted}, rejected=${rejected}`,
      );
      return;
    }
    const timeSlot = this.getTimeSlot();

    if (this.useRedis && this.redisClient) {
      // Redis-backed implementation
      const key = `pool:shares:${timeSlot}`;

      // Atomically increment accepted/rejected shares
      if (accepted > 0) {
        await this.redisClient.hIncrByFloat(key, 'accepted', accepted);
      }
      if (rejected > 0) {
        await this.redisClient.hIncrByFloat(key, 'rejected', rejected);
      }

      // Set expiry on key (24 hours)
      await this.redisClient.expire(key, 86400);
    } else {
      // Fallback in-memory implementation
      if (this.currentTimeSlot === null) {
        this.currentTimeSlot = timeSlot;
      } else if (this.currentTimeSlot !== timeSlot) {
        await this.flush();
        this.currentTimeSlot = timeSlot;
      }

      this.accepted += accepted;
      this.rejected += rejected;
    }
  }

  private async flush() {
    await this.mutex.runExclusive(async () => {
      if (this.useRedis && this.redisClient) {
        // Redis-backed implementation
        const pattern = 'pool:shares:*';
        const keys = await this.redisClient.keys(pattern);

        if (!keys || keys.length === 0) return;

        for (const key of keys) {
          const data = await this.redisClient.hGetAll(key);
          if (!data || (!data.accepted && !data.rejected)) continue;

          const accepted = parseFloat(data.accepted) || 0;
          const rejected = parseFloat(data.rejected) || 0;

          if (accepted === 0 && rejected === 0) continue;

          // Extract timeSlot from key (pool:shares:1234567890)
          const timeSlot = parseInt(key.split(':')[2]);
          const updatedAt = new Date();

          try {
            await this.poolShareStatisticsRepository
              .createQueryBuilder()
              .insert()
              .into(PoolShareStatisticsEntity)
              .values({
                time: timeSlot,
                accepted,
                rejected,
              })
              .onConflict(
                '("time") DO UPDATE SET "accepted" = "accepted" + EXCLUDED."accepted", "rejected" = "rejected" + EXCLUDED."rejected", "updatedAt" = :updatedAt',
              )
              .setParameters({ updatedAt })
              .execute();

            // Delete the Redis key after successful flush
            await this.redisClient.del(key);
          } catch (error: any) {
            // Suppress TypeORM entity ID mapping errors on upsert - the data is persisted despite the error
            if (error?.message?.includes('entity id is not set')) {
              await this.redisClient.del(key);
              return; // Data was successfully persisted
            }
            console.error(`[PoolShareStatisticsService] Failed to flush timeSlot ${timeSlot}:`, error);
            // Keep the key in Redis for retry on other errors
          }
        }
      } else {
        // Fallback in-memory implementation
        if (this.currentTimeSlot == null) return;
        if (this.accepted === 0 && this.rejected === 0) return;

        const accepted = this.accepted;
        const rejected = this.rejected;
        const timeSlot = this.currentTimeSlot;

        this.accepted = 0;
        this.rejected = 0;

        const updatedAt = new Date();

        try {
          await this.poolShareStatisticsRepository
            .createQueryBuilder()
            .insert()
            .into(PoolShareStatisticsEntity)
            .values({
              time: timeSlot,
              accepted,
              rejected,
            })
            .onConflict(
              '("time") DO UPDATE SET "accepted" = "accepted" + EXCLUDED."accepted", "rejected" = "rejected" + EXCLUDED."rejected", "updatedAt" = :updatedAt',
            )
            .setParameters({ updatedAt })
            .execute();
        } catch (error: any) {
          // Suppress TypeORM entity ID mapping errors on upsert - the data is persisted despite the error
          if (!error?.message?.includes('entity id is not set')) {
            this.accepted += accepted;
            this.rejected += rejected;
            throw error;
          }
          // Data was successfully persisted despite the TypeORM error
        }
      }
    });
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
