import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';

@Injectable()
export class PoolShareStatisticsService {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
  ) {}

  private currentTimeSlot: number = null;
  private lastSave: number = null;
  private accepted = 0;
  private rejected = 0;

  private async addShares(accepted: number, rejected: number) {
    const coeff = 1000 * 60 * 10;
    const now = Date.now();
    const timeSlot = Math.floor(now / coeff) * coeff;

    if (this.currentTimeSlot == null) {
      this.currentTimeSlot = timeSlot;
      this.accepted = accepted;
      this.rejected = rejected;
      await this.insert({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
      this.lastSave = now;
    } else if (this.currentTimeSlot !== timeSlot) {
      await this.update({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
      this.currentTimeSlot = timeSlot;
      this.accepted = accepted;
      this.rejected = rejected;
      await this.insert({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
      this.lastSave = now;
    } else if (now - this.lastSave > 60 * 1000) {
      this.accepted += accepted;
      this.rejected += rejected;
      await this.update({ time: this.currentTimeSlot, accepted: this.accepted, rejected: this.rejected });
      this.lastSave = now;
    } else {
      this.accepted += accepted;
      this.rejected += rejected;
    }
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
