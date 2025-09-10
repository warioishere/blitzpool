import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Mutex } from 'async-mutex';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';

@Injectable()
export class ClientRejectedStatisticsService {
  constructor(
    @InjectRepository(ClientRejectedStatisticsEntity)
    private clientRejectedStatisticsRepository: Repository<ClientRejectedStatisticsEntity>,
  ) {}

  private mutex = new Mutex();
  private currentTimeSlot: number = null;
  private lastSave: number = null;
  private counts: Map<string, Map<string, { count: number; shares: number }>> = new Map();

  @Interval(60 * 1000)
  private async flushInterval() {
    if (this.currentTimeSlot != null) {
      await this.mutex.runExclusive(async () => {
        await this.saveCurrent();
        this.lastSave = Date.now();
      });
    }
  }

  public async addRejectedShare(address: string, reason: string, diff: number) {
    await this.mutex.runExclusive(async () => {
      const coeff = 1000 * 60 * 10;
      const now = Date.now();
      const timeSlot = Math.floor(now / coeff) * coeff;

      if (this.currentTimeSlot == null) {
        this.currentTimeSlot = timeSlot;
        const existing = await this.clientRejectedStatisticsRepository.findBy({ time: timeSlot });
        this.counts.clear();
        for (const rec of existing) {
          if (!this.counts.has(rec.address)) {
            this.counts.set(rec.address, new Map());
          }
          this.counts
            .get(rec.address)
            .set(rec.reason, { count: rec.count, shares: rec.shares ?? 0 });
        }
        this.lastSave = now;
      }

      if (this.currentTimeSlot !== timeSlot) {
        await this.saveCurrent();
        this.currentTimeSlot = timeSlot;
        const existing = await this.clientRejectedStatisticsRepository.findBy({ time: timeSlot });
        this.counts.clear();
        for (const rec of existing) {
          if (!this.counts.has(rec.address)) {
            this.counts.set(rec.address, new Map());
          }
          this.counts
            .get(rec.address)
            .set(rec.reason, { count: rec.count, shares: rec.shares ?? 0 });
        }
        this.lastSave = now;
      }

      if (!this.counts.has(address)) {
        this.counts.set(address, new Map());
      }
      const addrMap = this.counts.get(address);
      const current = addrMap.get(reason) || { count: 0, shares: 0 };
      addrMap.set(reason, {
        count: current.count + 1,
        shares: current.shares + Math.max(0, diff - 1),
      });

      if (now - this.lastSave > 60 * 1000) {
        await this.saveCurrent();
        this.lastSave = now;
      }
    });
  }

  private async saveCurrent() {
    for (const [address, reasons] of this.counts) {
      for (const [reason, stats] of reasons) {
        const existing = await this.clientRejectedStatisticsRepository.findOneBy({
          time: this.currentTimeSlot,
          address,
          reason,
        });
        if (existing) {
          await this.clientRejectedStatisticsRepository.update(
            { time: this.currentTimeSlot, address, reason },
            { count: stats.count, shares: stats.shares, updatedAt: new Date() },
          );
        } else {
          await this.clientRejectedStatisticsRepository.insert({
            time: this.currentTimeSlot,
            address,
            reason,
            count: stats.count,
            shares: stats.shares,
          });
        }
      }
    }
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
