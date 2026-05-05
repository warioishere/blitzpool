import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';
import { MAX_REASONABLE_DIFFICULTY } from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

/**
 * Pool-wide accepted/rejected share aggregates per 10-min end-time slot.
 * Feeds /api/info/chart and /api/info/accepted.
 *
 * Direct PG writes (UPDATE … += diff) — same shape as PoolModeHashrateService
 * — instead of a Redis buffer flushed every 60 s by a coordinator. The
 * buffered version sporadically lost 60–80 % of a slot under load on
 * 2026-05-05 while pool_mode_hashrate (which has no buffer) stayed
 * accurate to <0.1 %. Removing the buffer brings this counter onto the
 * same write path as every other pool-side share counter.
 */
@Injectable()
export class PoolShareStatisticsService {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private readonly repo: Repository<PoolShareStatisticsEntity>,
  ) {}

  public async addAcceptedShare(difficulty: number): Promise<void> {
    await this.increment('accepted', difficulty);
  }

  public async addRejectedShare(difficulty: number): Promise<void> {
    await this.increment('rejected', difficulty);
  }

  /**
   * Add `diff` to `column` for the current end-time slot.
   *
   * Mirrors PoolModeHashrateService.incrementAccepted: try increment,
   * insert on miss, retry increment on unique-index race. Two round-trips
   * on cold-slot writes, one on warm-slot writes. Stats path, not on a
   * hot loop.
   *
   * Errors are caught and logged — a failed stats write must never block
   * a share submission.
   */
  private async increment(
    column: 'accepted' | 'rejected',
    diff: number,
  ): Promise<void> {
    if (!Number.isFinite(diff) || diff <= 0) return;

    // Defense-in-depth ceiling. The `accepted`/`rejected` columns are
    // Postgres `real` (max ~3.4e38). A single share above MAX_REASONABLE_
    // DIFFICULTY (~3× current network) is either a misconfigured SV2
    // client (e.g. OpenChannel with absurdly small maxTarget) or a
    // corruption attack — never a real miner. Discard with a loud
    // warning rather than poison the column with NaN/Infinity on flush.
    if (diff > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[PoolShareStatistics] Discarded out-of-range ${column} share: diff=${diff} (limit ${MAX_REASONABLE_DIFFICULTY})`,
      );
      return;
    }

    const slot = TimeSlotHelper.getCurrentSlot();
    try {
      const updated = await this.repo.increment({ time: slot }, column, diff);
      if ((updated.affected ?? 0) > 0) return;

      const fresh = column === 'accepted'
        ? { time: slot, accepted: diff, rejected: 0 }
        : { time: slot, accepted: 0, rejected: diff };

      try {
        await this.repo.insert(fresh);
      } catch {
        // Concurrent insert won the unique-index race — fall back to
        // incrementing the row the other writer just created. Final
        // state is identical to the single-writer case.
        await this.repo.increment({ time: slot }, column, diff);
      }
    } catch (err) {
      console.warn(
        `[PoolShareStatistics] increment ${column} failed:`,
        (err as Error).message,
      );
    }
  }

  public async getTotalsSince(
    time: number,
  ): Promise<{ accepted: number; rejected: number }> {
    const result = await this.repo
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
    return this.repo.find({
      where: { time: MoreThan(time) },
      order: { time: 'ASC' },
    });
  }
}
