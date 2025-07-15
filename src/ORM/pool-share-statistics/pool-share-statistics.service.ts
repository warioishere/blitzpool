import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mutex } from 'async-mutex';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';

@Injectable()
export class PoolShareStatisticsService {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
  ) {}

  private mutex = new Mutex();

  private currentTimeSlot: number = null;
  private lastSave: number = null;
  private accepted = 0;
  private rejected = 0;

  private async addShares(accepted: number, rejected: number) {
    await this.mutex.runExclusive(async () => {
      const coeff = 1000 * 60 * 10;
      const now = Date.now();
      const timeSlot = Math.floor(now / coeff) * coeff;

      if (this.currentTimeSlot == null) {
        const existing = await this.poolShareStatisticsRepository.findOneBy({ time: timeSlot });
        if (existing) {
          this.currentTimeSlot = existing.time;
          this.accepted = existing.accepted;
          this.rejected = existing.rejected;
          this.lastSave = now;
        } else {
          this.currentTimeSlot = timeSlot;
          this.accepted = 0;
          this.rejected = 0;
          await this.insert({ time: this.currentTimeSlot, accepted: 0, rejected: 0 });
          this.lastSave = now;
        }
      }

      if (this.currentTimeSlot !== timeSlot) {
        await this.update({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
        const existing = await this.poolShareStatisticsRepository.findOneBy({ time: timeSlot });
        if (existing) {
          this.currentTimeSlot = existing.time;
          this.accepted = existing.accepted;
          this.rejected = existing.rejected;
        } else {
          this.currentTimeSlot = timeSlot;
          this.accepted = 0;
          this.rejected = 0;
          await this.insert({ time: this.currentTimeSlot, accepted: 0, rejected: 0 });
        }
        this.lastSave = now;
      }

      this.accepted += accepted;
      this.rejected += rejected;

      if (now - this.lastSave > 60 * 1000) {
        await this.update({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
        this.lastSave = now;
      }
    });
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
}
