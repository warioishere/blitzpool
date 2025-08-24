import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Mutex } from 'async-mutex';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';

@Injectable()
export class PoolRejectedStatisticsService {
  constructor(
    @InjectRepository(PoolRejectedStatisticsEntity)
    private poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
  ) {}

  private mutex = new Mutex();
  private currentTimeSlot: number = null;
  private lastSave: number = null;
  private counts: Map<string, number> = new Map();
  private recentDiffs: Map<string, number[]> = new Map();

  @Interval(60 * 1000)
  private async flushInterval() {
    if (this.currentTimeSlot != null) {
      await this.mutex.runExclusive(async () => {
        await this.saveCurrent();
        this.lastSave = Date.now();
      });
    }
  }

  public async addRejectedShare(reason: string, diff: number): Promise<boolean> {
    return await this.mutex.runExclusive(async () => {
      const coeff = 1000 * 60 * 10;
      const now = Date.now();
      const timeSlot = Math.floor(now / coeff) * coeff;

      if (this.currentTimeSlot == null) {
        this.currentTimeSlot = timeSlot;
        const existing = await this.poolRejectedStatisticsRepository.findBy({ time: timeSlot });
        this.counts.clear();
        for (const rec of existing) {
          this.counts.set(rec.reason, rec.count);
        }
        this.lastSave = now;
      }

      if (this.currentTimeSlot !== timeSlot) {
        await this.saveCurrent();
        this.currentTimeSlot = timeSlot;
        const existing = await this.poolRejectedStatisticsRepository.findBy({ time: timeSlot });
        this.counts.clear();
        for (const rec of existing) {
          this.counts.set(rec.reason, rec.count);
        }
        this.lastSave = now;
      }

      let history = this.recentDiffs.get(reason) || [];
      if (history.length > 0) {
        const avg = history.reduce((sum, d) => sum + d, 0) / history.length;
        if (avg > 0 && diff > avg * 4) {
          history.push(diff);
          if (history.length > 20) {
            history.shift();
          }
          this.recentDiffs.set(reason, history);
          console.warn(`Anomalous diff ${diff} for reason ${reason} (avg ${avg})`);
          return false;
        }
      }

      history.push(diff);
      if (history.length > 20) {
        history.shift();
      }
      this.recentDiffs.set(reason, history);

      const current = this.counts.get(reason) || 0;
      this.counts.set(reason, current + diff);

      if (now - this.lastSave > 60 * 1000) {
        await this.saveCurrent();
        this.lastSave = now;
      }

      return true;
    });
  }

  private async saveCurrent() {
    for (const [reason, count] of this.counts) {
      const existing = await this.poolRejectedStatisticsRepository.findOneBy({ time: this.currentTimeSlot, reason });
      if (existing) {
        await this.poolRejectedStatisticsRepository.update(
          { time: this.currentTimeSlot, reason },
          { count, updatedAt: new Date() },
        );
      } else {
        await this.poolRejectedStatisticsRepository.insert({ time: this.currentTimeSlot, reason, count });
      }
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
