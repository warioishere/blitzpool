import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';

import { PoolRejectedStatisticsEntity } from './pool-rejected-statistics.entity';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { NestedDeltaBuffer } from '../../utils/buffers';

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
  private readonly slotDeltas = new NestedDeltaBuffer<number, string>();

  constructor(
    @InjectRepository(PoolRejectedStatisticsEntity)
    private poolRejectedStatisticsRepository: Repository<PoolRejectedStatisticsEntity>,
  ) {}

  /** Synchronous hot-path entry. Non-throwing. */
  public addRejectedShare(reason: string, diff: number): void {
    if (!reason || !Number.isFinite(diff) || diff <= 0) return;
    this.slotDeltas.add(TimeSlotHelper.getCurrentSlot(), reason, diff);
  }

  public drainSlotDeltas(): Map<number, SlotReasonMap> {
    return this.slotDeltas.drain();
  }

  public confirmFlush(flushed: Map<number, SlotReasonMap>): void {
    this.slotDeltas.confirm(flushed);
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
