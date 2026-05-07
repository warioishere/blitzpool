import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientEntity } from '../client/client.entity';
import { PoolShareStatisticsEntity } from '../pool-share-statistics/pool-share-statistics.entity';
import { DIFFICULTY_1, REDIS_STATISTICS_TTL } from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

@Injectable()
export class ClientStatisticsService implements OnModuleInit {
  constructor(
    @InjectRepository(ClientStatisticsEntity)
    private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private redisClient: any = null;

  async onModuleInit(): Promise<void> {
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        console.log('[ClientStatisticsService] Using Redis for atomic share increments');
      } else {
        console.error('[ClientStatisticsService] Redis not available - shares will not be tracked!');
      }
    } catch (error) {
      console.error('[ClientStatisticsService] Failed to access Redis client:', error);
    }
  }

  /**
   * Add an accepted share - writes directly to Redis atomically
   * Stateless - no in-memory accumulation
   * Mirrors PoolShareStatisticsService pattern
   */
  public async addAcceptedShare(client: ClientEntity, difficulty: number) {
    if (!Number.isFinite(difficulty)) {
      console.warn(`[ClientStatisticsService] Discarded non-finite share: difficulty=${difficulty}`);
      return;
    }

    if (!this.redisClient) {
      console.error('[ClientStatisticsService] Cannot track share - Redis not available');
      return;
    }

    const timeSlot = TimeSlotHelper.getCurrentSlot();
    const key = `client:shares:${client.address}:${client.clientName}:${client.sessionId}:${timeSlot}`;

    // Atomically increment accepted shares - INCREMENTAL, not accumulated!
    await Promise.all([
      this.redisClient.hIncrByFloat(key, 'shares', difficulty),
      this.redisClient.hIncrBy(key, 'acceptedCount', 1),
      this.redisClient.expire(key, REDIS_STATISTICS_TTL),
    ]);
  }

  /**
   * Add a rejected share - writes directly to Redis atomically
   * Stateless - no in-memory accumulation
   * Mirrors PoolShareStatisticsService pattern
   */
  public async addRejectedShare(client: ClientEntity, reason: string, difficulty: number) {
    if (!Number.isFinite(difficulty)) {
      difficulty = 0;
    }

    if (!this.redisClient) {
      console.error('[ClientStatisticsService] Cannot track rejected share - Redis not available');
      return;
    }

    const timeSlot = TimeSlotHelper.getCurrentSlot();
    const key = `client:shares:${client.address}:${client.clientName}:${client.sessionId}:${timeSlot}`;

    // Base rejected count increment
    const promises = [
      this.redisClient.hIncrBy(key, 'rejectedCount', 1),
      this.redisClient.expire(key, REDIS_STATISTICS_TTL),
    ];

    // Add reason-specific increments. Per-worker counters use a fixed
    // SQL schema (rejectedJobNotFoundCount, rejectedDuplicateShareCount,
    // rejectedLowDifficultyShareCount) — no dedicated `rejectedStaleCount`
    // column. Stale-rejected shares (introduced with the ckpool-style
    // retire-then-age refactor) are conflated INTO the JobNotFound
    // bucket on this per-worker counter so the UI's
    // `entry?.rejectedJobNotFound` field continues to mean "share
    // rejected with wire code 21" — both `JobNotFound` and `Stale`
    // emit code 21 over SV1 (and `stale-share` vs `invalid-job-id`
    // over SV2 — see SV2 spec §5.3.14). Operators who want to
    // distinguish the two failure modes can read
    // `pool_rejected_statistics` / `client_rejected_statistics`,
    // both of which use a schemaless reason field and DO see
    // `'Stale'` as a distinct counter.
    switch (reason) {
      case 'JobNotFound':
      case 'Stale':
        promises.push(this.redisClient.hIncrBy(key, 'rejectedJobNotFoundCount', 1));
        promises.push(this.redisClient.hIncrByFloat(key, 'rejectedJobNotFoundDiff1', difficulty));
        break;
      case 'DuplicateShare':
        promises.push(this.redisClient.hIncrBy(key, 'rejectedDuplicateShareCount', 1));
        promises.push(this.redisClient.hIncrByFloat(key, 'rejectedDuplicateShareDiff1', difficulty));
        break;
      case 'LowDifficultyShare':
        promises.push(this.redisClient.hIncrBy(key, 'rejectedLowDifficultyShareCount', 1));
        promises.push(this.redisClient.hIncrByFloat(key, 'rejectedLowDifficultyShareDiff1', difficulty));
        break;
    }

    await Promise.all(promises);
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

    const poolAggregates = await this.clientStatisticsRepository
      .createQueryBuilder('stat')
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
      await this.clientStatisticsRepository
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

    const workerAggregates = await this.clientStatisticsRepository
      .createQueryBuilder('stat')
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
      await this.clientStatisticsRepository
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

    await this.clientStatisticsRepository
      .createQueryBuilder()
      .delete()
      .from(ClientStatisticsEntity)
      .where('time < :detailCutoff', { detailCutoff: detailCutoffTimestamp })
      .andWhere(
        'NOT (sessionId = :agg OR (address = :pool AND clientName = :pool AND sessionId = :pool))',
        { agg: 'AGG', pool: 'POOL' },
      )
      .execute();

    await this.clientStatisticsRepository
      .createQueryBuilder()
      .delete()
      .from(ClientStatisticsEntity)
      .where('time < :halfYearCutoff', { halfYearCutoff: halfYearCutoffTimestamp })
      .andWhere('sessionId = :agg', { agg: 'AGG' })
      .execute();

    await this.clientStatisticsRepository
      .createQueryBuilder()
      .delete()
      .from(ClientStatisticsEntity)
      .where('time < :monthCutoff', { monthCutoff: monthCutoffTimestamp })
      .andWhere('address = :pool', { pool: 'POOL' })
      .andWhere('clientName = :pool', { pool: 'POOL' })
      .andWhere('sessionId = :pool', { pool: 'POOL' })
      .execute();
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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)

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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)

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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)

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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)
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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)

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
    const coeff = 1000 * 60 * 10; // 10-minute slots
    const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)

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
   * Clear all Redis cache keys for an address (used for delete operations)
   */
  public async clearRedisKeysForAddress(address: string): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    try {
      // Delete all client share keys for this address
      const pattern = `client:shares:${address}:*`;
      let cursor = '0';
      do {
        const result = await this.redisClient.scan(cursor, { MATCH: pattern, COUNT: 1000 });
        cursor = result.cursor.toString();
        if (result.keys.length > 0) {
          await this.redisClient.del(result.keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      console.error(`[ClientStatisticsService] Failed to clear Redis keys for address ${address}:`, error);
    }
  }
}
