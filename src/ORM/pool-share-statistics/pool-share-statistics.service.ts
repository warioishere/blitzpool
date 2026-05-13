import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';
import {
  MAX_REASONABLE_DIFFICULTY,
} from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { RecordDeltaBuffer } from '../../utils/buffers';

/**
 * Pool-wide accepted / rejected share counters keyed on 10-min end-time
 * slots. Writes accumulate in process memory; coordinator drains/flushes
 * to PG every 60s with INCREMENT-style upsert (so partial-slot flushes
 * are idempotent). Reads keep querying the same table as before.
 *
 * History: previously Redis-buffered (HINCRBYFLOAT `pool:shares:<slot>`)
 * which generated meaningful per-share Redis traffic + EXPIRE refresh
 * storm. Moving to in-process state eliminates both. The chart-visibility
 * cutoff in `TimeSlotHelper.getChartVisibilityCutoffSlot()` keeps just-ended
 * slots off the chart until the flush has committed them.
 */
type SlotBucket = { accepted: number; rejected: number };
const SLOT_FIELDS = ['accepted', 'rejected'] as const;

@Injectable()
export class PoolShareStatisticsService {
  private readonly slotDeltas = new RecordDeltaBuffer<number, 'accepted' | 'rejected'>(SLOT_FIELDS);

  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
  ) {}

  /** Synchronous hot-path entry. Non-throwing. */
  public addAcceptedShare(difficulty: number): void {
    this.handleShare(difficulty, 0);
  }

  public addRejectedShare(difficulty: number): void {
    this.handleShare(0, difficulty);
  }

  private handleShare(accepted: number, rejected: number): void {
    if (!Number.isFinite(accepted) || !Number.isFinite(rejected)) {
      console.warn(
        `discarded non-finite share stats: accepted=${accepted}, rejected=${rejected}`,
      );
      return;
    }

    // Defense-in-depth ceiling. The pool's Postgres `pool_share_statistics`
    // accepted/rejected columns are `real` (max ~3.4e38). If even a single
    // share (or accumulated bucket) exceeds the column range, the bulk
    // upsert fails and the flusher gets stuck on the bad bucket forever.
    // Real miners never legitimately submit shares above MAX_REASONABLE_
    // DIFFICULTY (~3x network). Anything bigger is a misconfigured SV2
    // client, a probing tool, or a corruption bug somewhere upstream.
    if (accepted > MAX_REASONABLE_DIFFICULTY || rejected > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[PoolShareStatisticsService] Discarded out-of-range share: accepted=${accepted}, rejected=${rejected} (limit ${MAX_REASONABLE_DIFFICULTY})`,
      );
      return;
    }

    if (accepted <= 0 && rejected <= 0) return;
    const timeSlot = TimeSlotHelper.getCurrentSlot();
    this.slotDeltas.addRecord(timeSlot, { accepted, rejected });
  }

  /**
   * Coordinator API — snapshot of pending slot deltas. Internal state NOT
   * cleared until `confirmFlush()` is called after PG upsert succeeds.
   */
  public drainSlotDeltas(): Map<number, SlotBucket> {
    return this.slotDeltas.drain();
  }

  /** Coordinator API — subtract a previously-drained snapshot. */
  public confirmFlush(flushed: Map<number, SlotBucket>): void {
    this.slotDeltas.confirm(flushed);
  }

  // ─── PG-direct API used by some legacy paths and the public chart API ───

  public async insert(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.insert(stat);
  }

  public async update(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.update(
      { time: stat.time },
      {
        accepted: stat.accepted,
        rejected: stat.rejected,
        updatedAt: Date.now(),
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
