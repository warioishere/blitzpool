import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan } from 'typeorm';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { RecordDeltaBuffer } from '../../utils/buffers';

/**
 * Per-address rejected-share counts bucketed per 10-min slot per reason.
 * Writes accumulate in process memory; coordinator drains/flushes to PG
 * every 60s via INCREMENT upsert so partial-slot flushes are idempotent.
 *
 * Shape: for each (address, slot, reason) we track both `count` (number
 * of rejects) and `shares` (sum of diff-1 values — the difficulty
 * "wasted" on the reject). PG schema is unchanged.
 */
const REASON_FIELDS = ['count', 'shares'] as const;

@Injectable()
export class ClientRejectedStatisticsService {
  // key: `${address}|${slot}|${reason}` — slot in keys to keep flush
  // grouping cheap. Could nest, but this flat shape is friendlier for
  // drain to record arrays.
  private readonly deltas = new RecordDeltaBuffer<string, 'count' | 'shares'>(REASON_FIELDS);

  constructor(
    @InjectRepository(ClientRejectedStatisticsEntity)
    private clientRejectedStatisticsRepository: Repository<ClientRejectedStatisticsEntity>,
  ) {}

  private keyOf(address: string, slot: number, reason: string): string {
    return `${address}|${slot}|${reason}`;
  }

  /** Synchronous hot-path entry. Non-throwing. */
  public addRejectedShare(address: string, reason: string, diff: number): void {
    if (!address || !reason || !Number.isFinite(diff)) return;

    const slot = TimeSlotHelper.getCurrentSlot();
    const k = this.keyOf(address, slot, reason);
    this.deltas.addRecord(k, { count: 1, shares: Math.max(0, diff - 1) });
  }

  /** Coordinator API — snapshot of pending deltas, in record shape. */
  public drainDeltas(): Array<{ address: string; time: number; reason: string; count: number; shares: number }> {
    const snap = this.deltas.drain();
    const out: Array<{ address: string; time: number; reason: string; count: number; shares: number }> = [];
    for (const [key, bucket] of snap) {
      const idx = key.indexOf('|');
      const idx2 = key.indexOf('|', idx + 1);
      const address = key.slice(0, idx);
      const time = parseInt(key.slice(idx + 1, idx2), 10);
      const reason = key.slice(idx2 + 1);
      out.push({ address, time, reason, count: bucket.count, shares: bucket.shares });
    }
    return out;
  }

  /** Coordinator API — subtract a previously-drained snapshot. */
  public confirmFlush(flushed: Array<{ address: string; time: number; reason: string; count: number; shares: number }>): void {
    const snap = new Map<string, Record<'count' | 'shares', number>>();
    for (const { address, time, reason, count, shares } of flushed) {
      snap.set(this.keyOf(address, time, reason), { count, shares });
    }
    this.deltas.confirm(snap);
  }

  /**
   * Drop all in-memory state for an address (called on account deletion).
   * Method kept under its legacy `clearRedisKeysForAddress` name + async
   * signature so callers in the controllers don't need to change.
   */
  public async clearRedisKeysForAddress(address: string): Promise<void> {
    const prefix = `${address}|`;
    this.deltas.deleteWhere(k => k.startsWith(prefix));
  }

  // ─── PG-direct API used by API endpoints ───

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

  public async deleteOlderThan(cutoff: number) {
    return await this.clientRejectedStatisticsRepository.delete({ time: LessThan(cutoff) });
  }

  public async deleteForAddress(address: string) {
    return await this.clientRejectedStatisticsRepository.delete({ address });
  }
}
