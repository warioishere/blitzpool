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
    // Keep detailed records for one week before aggregation
    const detailCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const halfYearCutoff = new Date(now - 180 * 24 * 60 * 60 * 1000);
    const monthCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // Aggregate old statistics so that only pool hashrate and worker totals are retained
    await this.clientStatisticsRepository.query(`
            INSERT INTO client_statistics_entity (
                address,
                clientName,
                sessionId,
                time,
                shares,
                acceptedCount,
                rejectedCount,
                "createdAt",
                "updatedAt"
            )
            SELECT
                'POOL',
                'POOL',
                'POOL',
                time,
                SUM(shares),
                SUM(acceptedCount),
                SUM(rejectedCount),
                datetime('now'),
                datetime('now')
            FROM client_statistics_entity
            WHERE time < ${detailCutoff.getTime()} AND NOT (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL') AND sessionId != 'AGG'
            GROUP BY time;
        `);

    await this.clientStatisticsRepository.query(`
            INSERT INTO client_statistics_entity (
                address,
                clientName,
                sessionId,
                time,
                shares,
                acceptedCount,
                rejectedCount,
                "createdAt",
                "updatedAt"
            )
            SELECT
                address,
                clientName,
                'AGG',
                ${detailCutoff.getTime()},
                SUM(shares),
                SUM(acceptedCount),
                SUM(rejectedCount),
                datetime('now'),
                datetime('now')
            FROM client_statistics_entity
            WHERE time < ${detailCutoff.getTime()} AND NOT (sessionId = 'AGG' OR (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL'))
            GROUP BY address, clientName;
        `);

    // Delete detailed records older than one day
    await this.clientStatisticsRepository.query(`
            DELETE FROM client_statistics_entity
            WHERE time < ${detailCutoff.getTime()} AND NOT (sessionId = 'AGG' OR (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL'));
        `);

    // Remove worker aggregates older than six months
    await this.clientStatisticsRepository.query(`
            DELETE FROM client_statistics_entity
            WHERE time < ${halfYearCutoff.getTime()} AND sessionId = 'AGG';
        `);

    // Remove pool aggregates older than one month
    await this.clientStatisticsRepository.query(`
            DELETE FROM client_statistics_entity
            WHERE time < ${monthCutoff.getTime()} AND address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL';
        `);
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

    const query = `
            SELECT
                time AS label,
                ROUND((SUM(shares) * ${DIFFICULTY_1}) / 600) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${since.getTime()} AND entry.sessionId != 'AGG'
            GROUP BY
                time
            ORDER BY
                time
            LIMIT ${limit};

    `;

    const result: any[] = await this.clientStatisticsRepository.query(query);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
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

    const query = `
                SELECT
                    time label,
                    (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = ? AND entry.time > ${since.getTime()}
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT ${limit};

        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
    ]);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
      .slice(0, result.length - 1);
  }

  public async getHashRateForGroup(address: string, clientName: string) {
    const query = `
            SELECT
                SUM(shares) as shares
            FROM client_statistics_entity
            WHERE address = ? AND clientName = ?
            GROUP BY time
            ORDER BY time DESC
            LIMIT 2;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
    ]);

    if (result.length < 1) {
      return 0;
    }

    const shares = result.reduce((sum, row) => sum + Number(row.shares), 0);

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

    const query = `
            SELECT
                time label,
                (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data,
                SUM(entry.acceptedCount) AS accepted,
                SUM(entry.rejectedCount) AS rejected
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${since.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT ${limit};
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
    ]);

    const parsed = result.map((res) => ({
      label: new Date(res.label).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
      accepted: res.accepted == null ? 0 : Number(res.accepted),
      rejected: res.rejected == null ? 0 : Number(res.rejected),
    }));

    return parsed.slice(0, parsed.length - 1);
  }

  public async getHashRateForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const query = `
            SELECT
                SUM(shares) as shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            GROUP BY time
            ORDER BY time DESC
            LIMIT 2;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
      sessionId,
    ]);

    if (result.length < 1) {
      return 0;
    }

    const shares = result.reduce((sum, row) => sum + Number(row.shares), 0);

    return this.calcHashRate(shares);
  }

  public async getChartDataForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const query = `
            SELECT
                time label,
                (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
      sessionId,
    ]);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
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

  public async deleteAll() {
    return await this.clientStatisticsRepository.delete({});
  }
}
