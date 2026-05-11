import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

/**
 * Pool-wide rejected-share counts bucketed per 10-min slot per reason
 * (JobNotFound, DuplicateShare, LowDifficultyShare, Stale, …). Writes
 * accumulate in process memory; coordinator drains/flushes to PG every
 * 60s via INCREMENT upsert so partial-slot flushes are idempotent.
 *
 * Previously Redis-buffered as `pool:rejected:<slot>` HASH with EXPIRE
 * refreshed on every accepted share. The EXPIRE storm was real and that's
 * now gone — flush mechanism handles slot lifetime via the same
 * `getChartVisibilityCutoffSlot()` filter used by every other chart endpoint.
 */
type SlotReasonMap = Map<string, number>;

@Injectable()
export class PoolRejectedStatisticsService {
  private readonly slotDeltas = new Map<number, SlotReasonMap>();

  constructor(
    @InjectRepository(PoolRejectedStatisticsEntity)
    private poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
  ) {}

  /** Synchronous hot-path entry. Non-throwing. */
  public addRejectedShare(reason: string, diff: number): void {
    if (!reason || !Number.isFinite(diff) || diff <= 0) return;

    const timeSlot = TimeSlotHelper.getCurrentSlot();
    let reasonMap = this.slotDeltas.get(timeSlot);
    if (!reasonMap) {
      reasonMap = new Map();
      this.slotDeltas.set(timeSlot, reasonMap);
    }
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + diff);
  }

  /** Coordinator API — snapshot of pending slot×reason deltas. */
  public drainSlotDeltas(): Map<number, SlotReasonMap> {
    const snapshot = new Map<number, SlotReasonMap>();
    for (const [slot, reasonMap] of this.slotDeltas) {
      const copy: SlotReasonMap = new Map();
      for (const [reason, count] of reasonMap) {
        if (count > 0) copy.set(reason, count);
      }
      if (copy.size > 0) snapshot.set(slot, copy);
    }
    return snapshot;
  }

  /** Coordinator API — subtract a previously-drained snapshot. */
  public confirmFlush(flushed: Map<number, SlotReasonMap>): void {
    for (const [slot, flushedReasons] of flushed) {
      const current = this.slotDeltas.get(slot);
      if (!current) continue;
      for (const [reason, amount] of flushedReasons) {
        const have = current.get(reason) ?? 0;
        const residual = have - amount;
        if (residual <= 0) current.delete(reason);
        else current.set(reason, residual);
      }
      if (current.size === 0) this.slotDeltas.delete(slot);
    }
  }

  // ─── PG-direct API used by the public API endpoints ───

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
