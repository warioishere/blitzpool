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
  private counts: Map<string, Map<string, Map<string, { count: number; diff: number }>>> = new Map();

  @Interval(60 * 1000)
  private async flushInterval() {
    if (this.currentTimeSlot != null) {
      await this.mutex.runExclusive(async () => {
        await this.saveCurrent();
        this.lastSave = Date.now();
      });
    }
  }

  public async addRejectedShare(
    address: string,
    clientName: string,
    reason: string,
    diff: number,
  ) {
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
          if (!this.counts.get(rec.address).has(rec.clientName)) {
            this.counts.get(rec.address).set(rec.clientName, new Map());
          }
          this.counts
            .get(rec.address)
            .get(rec.clientName)
            .set(rec.reason, { count: rec.count, diff: rec.diff });
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
          if (!this.counts.get(rec.address).has(rec.clientName)) {
            this.counts.get(rec.address).set(rec.clientName, new Map());
          }
          this.counts
            .get(rec.address)
            .get(rec.clientName)
            .set(rec.reason, { count: rec.count, diff: rec.diff });
        }
        this.lastSave = now;
      }

      if (!this.counts.has(address)) {
        this.counts.set(address, new Map());
      }
      if (!this.counts.get(address).has(clientName)) {
        this.counts.get(address).set(clientName, new Map());
      }
      const addrMap = this.counts.get(address).get(clientName);
      const current = addrMap.get(reason) || { count: 0, diff: 0 };
      addrMap.set(reason, { count: current.count + 1, diff: current.diff + diff });

      if (now - this.lastSave > 60 * 1000) {
        await this.saveCurrent();
        this.lastSave = now;
      }
    });
  }

  private async saveCurrent() {
    for (const [address, workers] of this.counts) {
      for (const [clientName, reasons] of workers) {
        for (const [reason, data] of reasons) {
          const existing = await this.clientRejectedStatisticsRepository.findOneBy({
            time: this.currentTimeSlot,
            address,
            clientName,
            reason,
          });
          if (existing) {
            await this.clientRejectedStatisticsRepository.update(
              { time: this.currentTimeSlot, address, clientName, reason },
              { count: data.count, diff: data.diff, updatedAt: new Date() },
            );
          } else {
            await this.clientRejectedStatisticsRepository.insert({
              time: this.currentTimeSlot,
              address,
              clientName,
              reason,
              count: data.count,
              diff: data.diff,
            });
          }
        }
      }
    }
  }

  public async getTotalsSince(
    address: string,
    time: number,
    clientName?: string,
    weighted: boolean = false,
  ): Promise<Record<string, number>> {
    const query = this.clientRejectedStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.reason', 'reason')
      .addSelect(`SUM(stat.${weighted ? 'diff' : 'count'})`, 'count')
      .where('stat.time > :time', { time })
      .andWhere('stat.address = :address', { address });
    if (clientName) {
      query.andWhere('stat.clientName = :clientName', { clientName });
    }
    query.groupBy('stat.reason');
    const result = await query.getRawMany();

    const totals: Record<string, number> = {};
    result.forEach(r => {
      totals[r.reason] = r.count ? parseFloat(r.count) : 0;
    });
    return totals;
  }

  public async getEntriesSince(
    address: string,
    time: number,
    clientName?: string,
  ): Promise<ClientRejectedStatisticsEntity[]> {
    if (clientName) {
      return this.clientRejectedStatisticsRepository.find({
        where: { address, clientName, time: MoreThan(time) },
        order: { time: 'ASC' },
      });
    }

    const raw = await this.clientRejectedStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('stat.reason', 'reason')
      .addSelect('SUM(stat.count)', 'count')
      .where('stat.address = :address', { address })
      .andWhere('stat.time > :time', { time })
      .groupBy('stat.time')
      .addGroupBy('stat.reason')
      .orderBy('stat.time', 'ASC')
      .getRawMany();

    return raw.map(r => ({
      id: 0,
      address,
      clientName: '',
      time: parseInt(r.time, 10),
      reason: r.reason,
      count: parseFloat(r.count),
      diff: 0,
      createdAt: null,
      updatedAt: null,
    })) as ClientRejectedStatisticsEntity[];
  }
}
