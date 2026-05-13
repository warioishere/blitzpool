import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientEntity } from '../client/client.entity';
import { PoolShareStatisticsEntity } from '../pool-share-statistics/pool-share-statistics.entity';
import { DIFFICULTY_1, MAX_REASONABLE_DIFFICULTY } from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

/**
 * In-memory bucket for an (address, clientName, sessionId, slot) tuple.
 * Mirrors the field set of the PG `client_statistics_entity` row.
 */
interface ClientSlotBucket {
  shares: number;
  acceptedCount: number;
  rejectedCount: number;
  rejectedJobNotFoundCount: number;
  rejectedJobNotFoundDiff1: number;
  rejectedDuplicateShareCount: number;
  rejectedDuplicateShareDiff1: number;
  rejectedLowDifficultyShareCount: number;
  rejectedLowDifficultyShareDiff1: number;
}

interface ClientSlotEntry {
  address: string;
  clientName: string;
  sessionId: string;
  time: number;
  bucket: ClientSlotBucket;
}

function emptyBucket(): ClientSlotBucket {
  return {
    shares: 0, acceptedCount: 0, rejectedCount: 0,
    rejectedJobNotFoundCount: 0, rejectedJobNotFoundDiff1: 0,
    rejectedDuplicateShareCount: 0, rejectedDuplicateShareDiff1: 0,
    rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0,
  };
}

@Injectable()
export class ClientStatisticsService {

  constructor(
    @InjectRepository(ClientStatisticsEntity)
    private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Per-client per-slot bucket store. Key encoding `${addr}|${worker}|${session}|${slot}`
   * is fine because addresses are base58/bech32 (no `|`), worker / session strings
   * are user-controlled but `|` is almost never used in mining client names.
   * The bucket carries a copy of the key components so drain can produce flat
   * records without re-parsing.
   */
  private readonly deltas = new Map<string, ClientSlotEntry>();

  private keyOf(address: string, clientName: string, sessionId: string, slot: number): string {
    return `${address}|${clientName}|${sessionId}|${slot}`;
  }

  /**
   * Add an accepted share. Synchronous in-memory increment; returns a
   * resolved Promise so existing `await` call sites don't break.
   */
  public async addAcceptedShare(client: ClientEntity, difficulty: number): Promise<void> {
    if (!Number.isFinite(difficulty)) {
      console.warn(`[ClientStatisticsService] Discarded non-finite share: difficulty=${difficulty}`);
      return;
    }
    // Defense-in-depth ceiling. `client_statistics_entity.shares` and the
    // four rejected*Diff1 columns are PG `real` (max ~3.4e38). The upstream
    // stratum channel-diff clamp normally prevents per-share values from
    // exceeding ~3× netdiff, but a misconfigured SV2 client opening a channel
    // with absurdly small maxTarget could slip through. Discard at write
    // time so the bucket stays flushable. Mirrors the guard in
    // PoolShareStatistics/PoolModeHashrate.
    if (difficulty > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[ClientStatisticsService] Discarded out-of-range accepted share: difficulty=${difficulty} (limit ${MAX_REASONABLE_DIFFICULTY})`,
      );
      return;
    }
    const slot = TimeSlotHelper.getCurrentSlot();
    const k = this.keyOf(client.address, client.clientName, client.sessionId, slot);
    let entry = this.deltas.get(k);
    if (!entry) {
      entry = { address: client.address, clientName: client.clientName, sessionId: client.sessionId, time: slot, bucket: emptyBucket() };
      this.deltas.set(k, entry);
    }
    entry.bucket.shares += difficulty;
    entry.bucket.acceptedCount += 1;
  }

  /**
   * Add a rejected share. The per-worker counters use a fixed SQL schema
   * (rejectedJobNotFoundCount, rejectedDuplicateShareCount, rejectedLowDifficultyShareCount).
   * Stale-rejected shares are conflated into the JobNotFound bucket on this
   * per-worker counter so the UI's `entry?.rejectedJobNotFound` field continues
   * to mean "share rejected with wire code 21" — both JobNotFound and Stale
   * emit code 21 over SV1 (and `stale-share` vs `invalid-job-id` over SV2).
   * Operators who want to distinguish the two failure modes can read
   * `pool_rejected_statistics` / `client_rejected_statistics`, both of which
   * use a schemaless reason field and see 'Stale' as a distinct counter.
   */
  public async addRejectedShare(client: ClientEntity, reason: string, difficulty: number): Promise<void> {
    if (!Number.isFinite(difficulty)) difficulty = 0;
    // Same `real`-column ceiling as the accepted path.
    if (difficulty > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[ClientStatisticsService] Discarded out-of-range rejected share (${reason}): difficulty=${difficulty} (limit ${MAX_REASONABLE_DIFFICULTY})`,
      );
      return;
    }

    const slot = TimeSlotHelper.getCurrentSlot();
    const k = this.keyOf(client.address, client.clientName, client.sessionId, slot);
    let entry = this.deltas.get(k);
    if (!entry) {
      entry = { address: client.address, clientName: client.clientName, sessionId: client.sessionId, time: slot, bucket: emptyBucket() };
      this.deltas.set(k, entry);
    }
    const b = entry.bucket;
    b.rejectedCount += 1;
    switch (reason) {
      case 'JobNotFound':
      case 'Stale':
        b.rejectedJobNotFoundCount += 1;
        b.rejectedJobNotFoundDiff1 += difficulty;
        break;
      case 'DuplicateShare':
        b.rejectedDuplicateShareCount += 1;
        b.rejectedDuplicateShareDiff1 += difficulty;
        break;
      case 'LowDifficultyShare':
        b.rejectedLowDifficultyShareCount += 1;
        b.rejectedLowDifficultyShareDiff1 += difficulty;
        break;
    }
  }

  /**
   * Coordinator API — snapshot of pending bucket deltas in record shape
   * compatible with the existing `bulkUpsertClientStatistics` UNNEST upsert.
   */
  public drainDeltas(): Array<{
    address: string; clientName: string; sessionId: string; time: number;
    shares: number; acceptedCount: number; rejectedCount: number;
    rejectedJobNotFoundCount: number; rejectedJobNotFoundDiff1: number;
    rejectedDuplicateShareCount: number; rejectedDuplicateShareDiff1: number;
    rejectedLowDifficultyShareCount: number; rejectedLowDifficultyShareDiff1: number;
  }> {
    const out: Array<any> = [];
    for (const { address, clientName, sessionId, time, bucket: b } of this.deltas.values()) {
      // Skip buckets that have nothing pending.
      if (b.shares === 0 && b.acceptedCount === 0 && b.rejectedCount === 0) continue;
      out.push({
        address, clientName, sessionId, time,
        shares: b.shares,
        acceptedCount: b.acceptedCount,
        rejectedCount: b.rejectedCount,
        rejectedJobNotFoundCount: b.rejectedJobNotFoundCount,
        rejectedJobNotFoundDiff1: b.rejectedJobNotFoundDiff1,
        rejectedDuplicateShareCount: b.rejectedDuplicateShareCount,
        rejectedDuplicateShareDiff1: b.rejectedDuplicateShareDiff1,
        rejectedLowDifficultyShareCount: b.rejectedLowDifficultyShareCount,
        rejectedLowDifficultyShareDiff1: b.rejectedLowDifficultyShareDiff1,
      });
    }
    return out;
  }

  /**
   * Coordinator API — subtract a previously-drained snapshot. Buckets that
   * end up fully empty are removed from the map.
   */
  public confirmFlush(flushed: Array<{ address: string; clientName: string; sessionId: string; time: number;
    shares: number; acceptedCount: number; rejectedCount: number;
    rejectedJobNotFoundCount: number; rejectedJobNotFoundDiff1: number;
    rejectedDuplicateShareCount: number; rejectedDuplicateShareDiff1: number;
    rejectedLowDifficultyShareCount: number; rejectedLowDifficultyShareDiff1: number;
  }>): void {
    for (const f of flushed) {
      const k = this.keyOf(f.address, f.clientName, f.sessionId, f.time);
      const entry = this.deltas.get(k);
      if (!entry) continue;
      const b = entry.bucket;
      b.shares -= f.shares;
      b.acceptedCount -= f.acceptedCount;
      b.rejectedCount -= f.rejectedCount;
      b.rejectedJobNotFoundCount -= f.rejectedJobNotFoundCount;
      b.rejectedJobNotFoundDiff1 -= f.rejectedJobNotFoundDiff1;
      b.rejectedDuplicateShareCount -= f.rejectedDuplicateShareCount;
      b.rejectedDuplicateShareDiff1 -= f.rejectedDuplicateShareDiff1;
      b.rejectedLowDifficultyShareCount -= f.rejectedLowDifficultyShareCount;
      b.rejectedLowDifficultyShareDiff1 -= f.rejectedLowDifficultyShareDiff1;
      if (b.shares <= 0 && b.acceptedCount <= 0 && b.rejectedCount <= 0
          && b.rejectedJobNotFoundCount <= 0 && b.rejectedDuplicateShareCount <= 0
          && b.rejectedLowDifficultyShareCount <= 0) {
        this.deltas.delete(k);
      }
    }
  }

  private calcHashRate(shares: number) {
    return (shares * DIFFICULTY_1) / 600;
  }

  public async update(clientStatistic: Partial<ClientStatisticsEntity>) {
    await this.clientStatisticsRepository.update(
      {
        address: clientStatistic.address,
        clientName: clientStatistic.clientName,
        sessionId: clientStatistic.sessionId,
        time: clientStatistic.time,
      },
      {
        shares: clientStatistic.shares,
        acceptedCount: clientStatistic.acceptedCount,
        rejectedCount: clientStatistic.rejectedCount,
        rejectedJobNotFoundCount: clientStatistic.rejectedJobNotFoundCount,
        rejectedJobNotFoundDiff1: clientStatistic.rejectedJobNotFoundDiff1,
        rejectedDuplicateShareCount: clientStatistic.rejectedDuplicateShareCount,
        rejectedDuplicateShareDiff1: clientStatistic.rejectedDuplicateShareDiff1,
        rejectedLowDifficultyShareCount:
          clientStatistic.rejectedLowDifficultyShareCount,
        rejectedLowDifficultyShareDiff1:
          clientStatistic.rejectedLowDifficultyShareDiff1,
        updatedAt: new Date(),
      },
    );
  }
  public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
    // If no rows were updated, insert a new record
    await this.clientStatisticsRepository.insert(clientStatistic);
  }

  public async bulkInsert(records: Array<Partial<ClientStatisticsEntity>>) {
    if (records.length === 0) {
      return;
    }

    // Note: Caller (StatisticsCoordinatorService) already batches to 1000 records max
    const databaseType = this.clientStatisticsRepository.manager.connection.options.type;

    if (databaseType === 'postgres') {
      // PostgreSQL: Use INSERT ... ON CONFLICT DO UPDATE (UPSERT)
      // Build the query manually to handle conflicts on composite key
      const values: any[] = [];
      let paramIndex = 1;

      const valueTuples = records.map(r => {
        const tuple = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12})`;
        values.push(
          r.address, r.clientName, r.sessionId, r.time,
          r.shares, r.acceptedCount, r.rejectedCount,
          r.rejectedJobNotFoundCount, r.rejectedJobNotFoundDiff1,
          r.rejectedDuplicateShareCount, r.rejectedDuplicateShareDiff1,
          r.rejectedLowDifficultyShareCount, r.rejectedLowDifficultyShareDiff1
        );
        paramIndex += 13;
        return tuple;
      }).join(', ');

      const query = `
        INSERT INTO client_statistics_entity
          (address, "clientName", "sessionId", time, shares, "acceptedCount", "rejectedCount",
           "rejectedJobNotFoundCount", "rejectedJobNotFoundDiff1", "rejectedDuplicateShareCount",
           "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareCount", "rejectedLowDifficultyShareDiff1")
        VALUES ${valueTuples}
        ON CONFLICT (address, "clientName", "sessionId", time)
        DO UPDATE SET
          shares = EXCLUDED.shares,
          "acceptedCount" = EXCLUDED."acceptedCount",
          "rejectedCount" = EXCLUDED."rejectedCount",
          "rejectedJobNotFoundCount" = EXCLUDED."rejectedJobNotFoundCount",
          "rejectedJobNotFoundDiff1" = EXCLUDED."rejectedJobNotFoundDiff1",
          "rejectedDuplicateShareCount" = EXCLUDED."rejectedDuplicateShareCount",
          "rejectedDuplicateShareDiff1" = EXCLUDED."rejectedDuplicateShareDiff1",
          "rejectedLowDifficultyShareCount" = EXCLUDED."rejectedLowDifficultyShareCount",
          "rejectedLowDifficultyShareDiff1" = EXCLUDED."rejectedLowDifficultyShareDiff1",
          "updatedAt" = NOW()
      `;

      await this.clientStatisticsRepository.query(query, values);
    } else {
      // SQLite: Use INSERT OR REPLACE (UPSERT)
      const values: any[] = [];

      const valueTuples = records.map(r => {
        const tuple = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        values.push(
          r.address, r.clientName, r.sessionId, r.time,
          r.shares, r.acceptedCount, r.rejectedCount,
          r.rejectedJobNotFoundCount, r.rejectedJobNotFoundDiff1,
          r.rejectedDuplicateShareCount, r.rejectedDuplicateShareDiff1,
          r.rejectedLowDifficultyShareCount, r.rejectedLowDifficultyShareDiff1
        );
        return tuple;
      }).join(', ');

      const query = `
        INSERT OR REPLACE INTO client_statistics_entity
          (address, clientName, sessionId, time, shares, acceptedCount, rejectedCount,
           rejectedJobNotFoundCount, rejectedJobNotFoundDiff1, rejectedDuplicateShareCount,
           rejectedDuplicateShareDiff1, rejectedLowDifficultyShareCount, rejectedLowDifficultyShareDiff1)
        VALUES ${valueTuples}
      `;

      await this.clientStatisticsRepository.query(query, values);
    }
  }

  public async bulkUpdate(updates: Array<Partial<ClientStatisticsEntity>>) {
    if (updates.length === 0) {
      return;
    }

    // Note: Caller (StatisticsCoordinatorService) already batches to 1000 records max
    const databaseType = this.clientStatisticsRepository.manager.connection.options.type;
    const parameters: any[] = [];

    // Build CASE statements for each field
    const dataFields = [
      'shares', 'acceptedCount', 'rejectedCount',
      'rejectedJobNotFoundCount', 'rejectedJobNotFoundDiff1',
      'rejectedDuplicateShareCount', 'rejectedDuplicateShareDiff1',
      'rejectedLowDifficultyShareCount', 'rejectedLowDifficultyShareDiff1'
    ];

    if (databaseType === 'postgres') {
      // PostgreSQL version
      let paramIndex = 1;
      const caseParts: Record<string, string[]> = {};

      dataFields.forEach(field => {
        caseParts[field] = [];
      });

      updates.forEach((update) => {
        const keyParams = [paramIndex, paramIndex + 1, paramIndex + 2, paramIndex + 3];
        parameters.push(update.address, update.clientName, update.sessionId, update.time);
        paramIndex += 4;

        dataFields.forEach(field => {
          caseParts[field].push(`WHEN ($${keyParams[0]}, $${keyParams[1]}, $${keyParams[2]}, $${keyParams[3]}) THEN $${paramIndex}`);
          parameters.push(update[field]);
          paramIndex++;
        });
      });

      const setClauses = dataFields.map(field =>
        `"${field}" = CASE (address, "clientName", "sessionId", time) ${caseParts[field].join(' ')} END`
      ).join(', ');

      const whereTuples = updates.map((_, idx) => {
        const base = paramIndex;
        paramIndex += 4;
        return `($${base}, $${base + 1}, $${base + 2}, $${base + 3})`;
      }).join(', ');

      updates.forEach(u => {
        parameters.push(u.address, u.clientName, u.sessionId, u.time);
      });

      const query = `
        UPDATE client_statistics_entity
        SET ${setClauses}, "updatedAt" = NOW()
        WHERE (address, "clientName", "sessionId", time) IN (${whereTuples})
      `;

      await this.clientStatisticsRepository.query(query, parameters);
    } else {
      // SQLite version
      const caseParts: Record<string, string[]> = {};

      dataFields.forEach(field => {
        caseParts[field] = [];
      });

      updates.forEach((update) => {
        parameters.push(update.address, update.clientName, update.sessionId, update.time);

        dataFields.forEach(field => {
          caseParts[field].push(`WHEN (?, ?, ?, ?) THEN ?`);
          parameters.push(update[field]);
        });
      });

      const setClauses = dataFields.map(field =>
        `${field} = CASE (address, clientName, sessionId, time) ${caseParts[field].join(' ')} END`
      ).join(', ');

      const wherePlaceholders = updates.map(() => '(?, ?, ?, ?)').join(', ');

      updates.forEach(u => {
        parameters.push(u.address, u.clientName, u.sessionId, u.time);
      });

      const query = `
        UPDATE client_statistics_entity
        SET ${setClauses}, updatedAt = datetime('now')
        WHERE (address, clientName, sessionId, time) IN (${wherePlaceholders})
      `;

      await this.clientStatisticsRepository.query(query, parameters);
    }
  }

  public async deleteOldStatistics() {
    const now = Date.now();
    const detailCutoffTimestamp = new Date(now - 7 * 24 * 60 * 60 * 1000).getTime();
    const halfYearCutoffTimestamp = new Date(now - 180 * 24 * 60 * 60 * 1000).getTime();
    const monthCutoffTimestamp = new Date(now - 30 * 24 * 60 * 60 * 1000).getTime();

    const baseFilters = {
      detailCutoff: detailCutoffTimestamp,
      pool: 'POOL',
      agg: 'AGG',
    } as const;

    // Wrap the five mutations in a single transaction so an interrupt
    // (OOM-kill, container stop, uncaughtException trap, DB connection
    // reset) anywhere in the routine leaves the table in a consistent
    // state — either all aggregates committed AND raw rows deleted, or
    // nothing applied. Without this, a crash between the POOL insert
    // (step 1) and the raw-row delete (step 3) would leave orphan raw
    // rows for already-aggregated slots, and the next cron tick would
    // hit a unique-key violation when trying to re-insert the same
    // (POOL, POOL, POOL, slot) aggregate.
    //
    // Lock-scope is safe: the routine only touches rows with
    // `time < detailCutoff` (7+ days old). The coordinator's hot-path
    // INSERTs write only current-slot rows. Disjoint row sets → no
    // contention even with a long transaction. Default READ COMMITTED
    // isolation is fine.
    await this.dataSource.transaction(async (manager) => {
      const poolAggregates = await manager
        .createQueryBuilder(ClientStatisticsEntity, 'stat')
        .select('stat.time', 'time')
        .addSelect('SUM(stat.shares)', 'shares')
        .addSelect('SUM(stat.acceptedCount)', 'acceptedCount')
        .addSelect('SUM(stat.rejectedCount)', 'rejectedCount')
        .addSelect('SUM(stat.rejectedJobNotFoundCount)', 'rejectedJobNotFoundCount')
        .addSelect('SUM(stat.rejectedJobNotFoundDiff1)', 'rejectedJobNotFoundDiff1')
        .addSelect('SUM(stat.rejectedDuplicateShareCount)', 'rejectedDuplicateShareCount')
        .addSelect('SUM(stat.rejectedDuplicateShareDiff1)', 'rejectedDuplicateShareDiff1')
        .addSelect('SUM(stat.rejectedLowDifficultyShareCount)', 'rejectedLowDifficultyShareCount')
        .addSelect('SUM(stat.rejectedLowDifficultyShareDiff1)', 'rejectedLowDifficultyShareDiff1')
        .where('stat.time < :detailCutoff', baseFilters)
        .andWhere(
          'NOT (stat.address = :pool AND stat.clientName = :pool AND stat.sessionId = :pool)',
          baseFilters,
        )
        .andWhere('stat.sessionId != :agg', baseFilters)
        .groupBy('stat.time')
        .getRawMany();

      if (poolAggregates.length > 0) {
        const insertedAt = new Date();
        await manager
          .createQueryBuilder()
          .insert()
          .into(ClientStatisticsEntity)
          .values(
            poolAggregates.map((row) => ({
              address: 'POOL',
              clientName: 'POOL',
              sessionId: 'POOL',
              time: Number(row.time),
              shares: Number(row.shares ?? 0),
              acceptedCount: Number(row.acceptedCount ?? 0),
              rejectedCount: Number(row.rejectedCount ?? 0),
              rejectedJobNotFoundCount: Number(row.rejectedJobNotFoundCount ?? 0),
              rejectedJobNotFoundDiff1: Number(row.rejectedJobNotFoundDiff1 ?? 0),
              rejectedDuplicateShareCount: Number(row.rejectedDuplicateShareCount ?? 0),
              rejectedDuplicateShareDiff1: Number(row.rejectedDuplicateShareDiff1 ?? 0),
              rejectedLowDifficultyShareCount: Number(row.rejectedLowDifficultyShareCount ?? 0),
              rejectedLowDifficultyShareDiff1: Number(row.rejectedLowDifficultyShareDiff1 ?? 0),
              createdAt: insertedAt,
              updatedAt: insertedAt,
            })),
          )
          .execute();
      }

      const workerAggregates = await manager
        .createQueryBuilder(ClientStatisticsEntity, 'stat')
        .select('stat.address', 'address')
        .addSelect('stat.clientName', 'clientName')
        .addSelect('SUM(stat.shares)', 'shares')
        .addSelect('SUM(stat.acceptedCount)', 'acceptedCount')
        .addSelect('SUM(stat.rejectedCount)', 'rejectedCount')
        .addSelect('SUM(stat.rejectedJobNotFoundCount)', 'rejectedJobNotFoundCount')
        .addSelect('SUM(stat.rejectedJobNotFoundDiff1)', 'rejectedJobNotFoundDiff1')
        .addSelect('SUM(stat.rejectedDuplicateShareCount)', 'rejectedDuplicateShareCount')
        .addSelect('SUM(stat.rejectedDuplicateShareDiff1)', 'rejectedDuplicateShareDiff1')
        .addSelect('SUM(stat.rejectedLowDifficultyShareCount)', 'rejectedLowDifficultyShareCount')
        .addSelect('SUM(stat.rejectedLowDifficultyShareDiff1)', 'rejectedLowDifficultyShareDiff1')
        .where('stat.time < :detailCutoff', baseFilters)
        .andWhere('stat.sessionId != :agg', baseFilters)
        .andWhere(
          'NOT (stat.address = :pool AND stat.clientName = :pool AND stat.sessionId = :pool)',
          baseFilters,
        )
        .groupBy('stat.address')
        .addGroupBy('stat.clientName')
        .getRawMany();

      if (workerAggregates.length > 0) {
        const insertedAt = new Date();
        await manager
          .createQueryBuilder()
          .insert()
          .into(ClientStatisticsEntity)
          .values(
            workerAggregates.map((row) => ({
              address: row.address,
              clientName: row.clientName,
              sessionId: 'AGG',
              time: detailCutoffTimestamp,
              shares: Number(row.shares ?? 0),
              acceptedCount: Number(row.acceptedCount ?? 0),
              rejectedCount: Number(row.rejectedCount ?? 0),
              rejectedJobNotFoundCount: Number(row.rejectedJobNotFoundCount ?? 0),
              rejectedJobNotFoundDiff1: Number(row.rejectedJobNotFoundDiff1 ?? 0),
              rejectedDuplicateShareCount: Number(row.rejectedDuplicateShareCount ?? 0),
              rejectedDuplicateShareDiff1: Number(row.rejectedDuplicateShareDiff1 ?? 0),
              rejectedLowDifficultyShareCount: Number(row.rejectedLowDifficultyShareCount ?? 0),
              rejectedLowDifficultyShareDiff1: Number(row.rejectedLowDifficultyShareDiff1 ?? 0),
              createdAt: insertedAt,
              updatedAt: insertedAt,
            })),
          )
          .execute();
      }

      await manager
        .createQueryBuilder()
        .delete()
        .from(ClientStatisticsEntity)
        .where('time < :detailCutoff', { detailCutoff: detailCutoffTimestamp })
        .andWhere(
          'NOT (sessionId = :agg OR (address = :pool AND clientName = :pool AND sessionId = :pool))',
          { agg: 'AGG', pool: 'POOL' },
        )
        .execute();

      await manager
        .createQueryBuilder()
        .delete()
        .from(ClientStatisticsEntity)
        .where('time < :halfYearCutoff', { halfYearCutoff: halfYearCutoffTimestamp })
        .andWhere('sessionId = :agg', { agg: 'AGG' })
        .execute();

      await manager
        .createQueryBuilder()
        .delete()
        .from(ClientStatisticsEntity)
        .where('time < :monthCutoff', { monthCutoff: monthCutoffTimestamp })
        .andWhere('address = :pool', { pool: 'POOL' })
        .andWhere('clientName = :pool', { pool: 'POOL' })
        .andWhere('sessionId = :pool', { pool: 'POOL' })
        .execute();
    });
  }

  public async getChartDataForSite(range: '1d' | '1m' = '1d') {
    let diffDays = 1;

    switch (range) {
      case '1m':
        diffDays = 30;
        break;
      default:
        diffDays = 1;
    }

    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed

    const since = new Date(now - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;
    const result = await this.poolShareStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`ROUND((entry.accepted * ${DIFFICULTY_1}) / 600)`, 'data')
      .where('entry.time >= :since', { since: since.getTime() })
      .andWhere('entry.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    return result.map((res) => ({
      label: new Date(Number(res.label)).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
    }));
  }

  // public async getHashRateForAddress(address: string) {

  //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

  //     const query = `
  //         SELECT
  //         SUM(entry.shares) AS difficultySum
  //         FROM
  //             client_statistics_entity AS entry
  //         WHERE
  //             entry.address = ? AND entry.time > ${oneHour}
  //     `;

  //     const result = await this.clientStatisticsRepository.query(query, [address]);

  //     const difficultySum = result[0].difficultySum;

  //     return (difficultySum * 4294967296) / (600);

  // }

  public async getChartDataForAddress(
    address: string,
    range: '1d' | '3d' | '7d' = '1d',
  ) {
    let diffDays = 1;

    switch (range) {
      case '3d':
        diffDays = 3;
        break;
      case '7d':
        diffDays = 7;
        break;
      default:
        diffDays = 1;
    }

    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed

    const since = new Date(now - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`(SUM(entry.shares) * ${DIFFICULTY_1}) / 600`, 'data')
      .where('entry.address = :address', { address })
      .andWhere('entry.time >= :since', { since: since.getTime() })
      .andWhere('entry.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    return result.map((res) => ({
      label: new Date(Number(res.label)).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
    }));
  }

  public async getHashRateForGroup(address: string, clientName: string) {
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('SUM(entry.shares)', 'shares')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :clientName', { clientName })
      .groupBy('entry.time')
      .orderBy('entry.time', 'DESC')
      .limit(2)
      .getRawMany();

    if (result.length < 1) {
      return 0;
    }

    const shares = result.reduce((sum, row) => sum + Number(row.shares ?? 0), 0);

    return this.calcHashRate(shares);
  }

  public async getChartDataForGroup(
    address: string,
    clientName: string,
    range: '1d' | '3d' | '7d' = '1d',
  ) {
    let diffDays = 1;

    switch (range) {
      case '3d':
        diffDays = 3;
        break;
      case '7d':
        diffDays = 7;
        break;
      default:
        diffDays = 1;
    }

    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed

    const since = new Date(now - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`(SUM(entry.shares) * ${DIFFICULTY_1}) / 600`, 'data')
      .addSelect('SUM(entry.shares)', 'accepted')
      .addSelect('SUM(entry.rejectedJobNotFoundCount)', 'rejectedJobNotFound')
      .addSelect('SUM(entry.rejectedJobNotFoundDiff1)', 'rejectedJobNotFoundDiff1')
      .addSelect('SUM(entry.rejectedDuplicateShareCount)', 'rejectedDuplicatedShare')
      .addSelect('SUM(entry.rejectedDuplicateShareDiff1)', 'rejectedDuplicatedShareDiff1')
      .addSelect('SUM(entry.rejectedLowDifficultyShareCount)', 'rejectedLowDifficultyShare')
      .addSelect('SUM(entry.rejectedLowDifficultyShareDiff1)', 'rejectedLowDifficultyShareDiff1')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :clientName', { clientName })
      .andWhere('entry.time >= :since', { since: since.getTime() })
      .andWhere('entry.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    return result.map((res) => ({
      label: new Date(Number(res.label)).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
      accepted: Number(res.accepted ?? 0),
      rejectedJobNotFound: res.rejectedJobNotFound == null
        ? 0
        : Number(res.rejectedJobNotFound),
      rejectedJobNotFoundDiff1: res.rejectedJobNotFoundDiff1 == null
        ? 0
        : Number(res.rejectedJobNotFoundDiff1),
      rejectedDuplicatedShare: res.rejectedDuplicatedShare == null
        ? 0
        : Number(res.rejectedDuplicatedShare),
      rejectedDuplicatedShareDiff1:
        res.rejectedDuplicatedShareDiff1 == null
          ? 0
          : Number(res.rejectedDuplicatedShareDiff1),
      rejectedLowDifficultyShare: res.rejectedLowDifficultyShare == null
        ? 0
        : Number(res.rejectedLowDifficultyShare),
      rejectedLowDifficultyShareDiff1:
        res.rejectedLowDifficultyShareDiff1 == null
          ? 0
          : Number(res.rejectedLowDifficultyShareDiff1),
    }));
  }

  public async getHashRateForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('SUM(entry.shares)', 'shares')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :clientName', { clientName })
      .andWhere('entry.sessionId = :sessionId', { sessionId })
      .groupBy('entry.time')
      .orderBy('entry.time', 'DESC')
      .limit(2)
      .getRawMany();

    if (result.length < 1) {
      return 0;
    }

    const shares = result.reduce((sum, row) => sum + Number(row.shares ?? 0), 0);

    return this.calcHashRate(shares);
  }

  public async getChartDataForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed
    const yesterday = new Date(now - 24 * 60 * 60 * 1000);

    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`(SUM(entry.shares) * ${DIFFICULTY_1}) / 600`, 'data')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :clientName', { clientName })
      .andWhere('entry.sessionId = :sessionId', { sessionId })
      .andWhere('entry.time >= :since', { since: yesterday.getTime() })
      .andWhere('entry.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(144)
      .getRawMany();

    return result.map((res) => ({
      label: new Date(Number(res.label)).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
    }));
  }

  public async getActiveCountsSince(time: number): Promise<
    Array<{
      time: number;
      addresses: number;
      workers: number;
    }>
  > {
    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed

    const query = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('COUNT(DISTINCT stat.address)', 'addresses')
      .addSelect(
        "COUNT(DISTINCT stat.address || '-' || stat.clientName)",
        'workers',
      )
      .where('stat.time > :since', { since: time })
      .andWhere('stat.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .andWhere("stat.sessionId != 'AGG'")
      .andWhere("stat.address != 'POOL'")
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await query.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      addresses: Number(r.addresses),
      workers: Number(r.workers),
    }));
  }

  public async getActiveCountsForAddress(
    address: string,
    time: number,
  ): Promise<
    Array<{
      time: number;
      workers: number;
      sessions: number;
    }>
  > {
    const now = Date.now();
    const currentSlot = TimeSlotHelper.getChartVisibilityCutoffSlot(); // Chart-visible cutoff: hides slot until flush has committed

    const query = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('COUNT(DISTINCT stat.clientName)', 'workers')
      .addSelect(
        "COUNT(DISTINCT stat.clientName || '-' || stat.sessionId)",
        'sessions',
      )
      .where('stat.address = :address', { address })
      .andWhere('stat.time > :since', { since: time })
      .andWhere('stat.time < :currentSlot', { currentSlot }) // Exclude current incomplete slot
      .andWhere("stat.sessionId != 'AGG'")
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await query.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      workers: Number(r.workers),
      sessions: Number(r.sessions),
    }));
  }

  public async getAcceptedEntriesSince(
    address: string,
    time: number,
  ): Promise<Array<{ time: number; shares: number }>> {
    const query = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('SUM(stat.shares)', 'shares')
      .where('stat.address = :address', { address })
      .andWhere('stat.time > :time', { time })
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await query.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      shares: Number(r.shares),
    }));
  }

  public async getTotalSharesForAddress(address: string): Promise<number> {
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('SUM(entry.shares)', 'total')
      .where('entry.address = :address', { address })
      .getRawOne();
    return result?.total ? parseFloat(result.total) : 0;
  }

  public async getTotalSharesForWorkers(
    address: string,
  ): Promise<Array<{ clientName: string; total: number }>> {
    const results = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.clientName', 'clientName')
      .addSelect('SUM(entry.shares)', 'total')
      .where('entry.address = :address', { address })
      .groupBy('entry.clientName')
      .getRawMany();
    return results.map((r) => ({
      clientName: r.clientName,
      total: parseFloat(r.total),
    }));
  }

  public async getTotalSharesForWorker(
    address: string,
    workerName: string,
  ): Promise<number> {
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('SUM(entry.shares)', 'total')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :workerName', { workerName })
      .getRawOne();

    return result?.total ? parseFloat(result.total) : 0;
  }

  public async getTotalRejectedForWorkers(
    address: string,
  ): Promise<Array<{ clientName: string; totalRejected: number }>> {
    const results = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.clientName', 'clientName')
      .addSelect('SUM(entry.rejectedJobNotFoundDiff1 + entry.rejectedDuplicateShareDiff1 + entry.rejectedLowDifficultyShareDiff1)', 'totalRejected')
      .where('entry.address = :address', { address })
      .groupBy('entry.clientName')
      .getRawMany();
    return results.map((r) => ({
      clientName: r.clientName,
      totalRejected: r.totalRejected ? parseFloat(r.totalRejected) : 0,
    }));
  }

  public async deleteAll() {
    return await this.clientStatisticsRepository.delete({});
  }

  public async deleteForAddress(address: string) {
    return await this.clientStatisticsRepository.delete({ address });
  }

  /**
   * Drop all in-memory pending deltas for an address (called on account
   * deletion). Method kept under its legacy `clearRedisKeysForAddress`
   * name + async signature so callers in the controllers don't need to
   * change.
   */
  public async clearRedisKeysForAddress(address: string): Promise<void> {
    const prefix = `${address}|`;
    for (const k of this.deltas.keys()) {
      if (k.startsWith(prefix)) this.deltas.delete(k);
    }
  }
}
