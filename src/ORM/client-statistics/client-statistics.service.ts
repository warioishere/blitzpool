import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';

const DIFFICULTY_1 = 4294967296;

@Injectable()
export class ClientStatisticsService {
  constructor(
    @InjectRepository(ClientStatisticsEntity)
    private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
  ) {}

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

    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`ROUND((SUM(entry.shares) * ${DIFFICULTY_1}) / 600)`, 'data')
      .where('entry.time > :since', { since: since.getTime() })
      .andWhere('entry.sessionId != :agg', { agg: 'AGG' })
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    return result
      .map((res) => ({
        label: new Date(Number(res.label)).toISOString(),
        data: res.data == null ? 0 : Number(res.data),
      }))
      .slice(0, result.length - 1);
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

    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;
    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`(SUM(entry.shares) * ${DIFFICULTY_1}) / 600`, 'data')
      .where('entry.address = :address', { address })
      .andWhere('entry.time > :since', { since: since.getTime() })
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    return result
      .map((res) => ({
        label: new Date(Number(res.label)).toISOString(),
        data: res.data == null ? 0 : Number(res.data),
      }))
      .slice(0, result.length - 1);
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

    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
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
      .andWhere('entry.time > :since', { since: since.getTime() })
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(limit)
      .getRawMany();

    const parsed = result.map((res) => ({
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

    return parsed.slice(0, parsed.length - 1);
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
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const result = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.time', 'label')
      .addSelect(`(SUM(entry.shares) * ${DIFFICULTY_1}) / 600`, 'data')
      .where('entry.address = :address', { address })
      .andWhere('entry.clientName = :clientName', { clientName })
      .andWhere('entry.sessionId = :sessionId', { sessionId })
      .andWhere('entry.time > :since', { since: yesterday.getTime() })
      .groupBy('entry.time')
      .orderBy('entry.time', 'ASC')
      .limit(144)
      .getRawMany();

    return result
      .map((res) => ({
        label: new Date(Number(res.label)).toISOString(),
        data: res.data == null ? 0 : Number(res.data),
      }))
      .slice(0, result.length - 1);
  }

  public async getActiveCountsSince(time: number): Promise<
    Array<{
      time: number;
      addresses: number;
      workers: number;
      sessions: number;
    }>
  > {
    const query = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('COUNT(DISTINCT stat.address)', 'addresses')
      .addSelect(
        "COUNT(DISTINCT stat.address || '-' || stat.clientName)",
        'workers',
      )
      .addSelect(
        "COUNT(DISTINCT stat.address || '-' || stat.clientName || '-' || stat.sessionId)",
        'sessions',
      )
      .where('stat.time > :since', { since: time })
      .andWhere("stat.sessionId != 'AGG'")
      .andWhere("stat.address != 'POOL'")
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await query.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      addresses: Number(r.addresses),
      workers: Number(r.workers),
      sessions: Number(r.sessions),
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

  public async deleteAll() {
    return await this.clientStatisticsRepository.delete({});
  }
}
