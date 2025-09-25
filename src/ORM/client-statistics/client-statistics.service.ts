import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ClientStatisticsEntity } from './client-statistics.entity';

const DIFFICULTY_1 = 4294967296;

@Injectable()
export class ClientStatisticsService {
  private readonly isPg: boolean;
  private readonly nowSql: string;
  private readonly qp: (i: number) => string; // placeholder helper

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ClientStatisticsEntity)
    private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
  ) {
    const dbType = (this.dataSource.options as any)?.type;
    this.isPg = dbType === 'postgres';
    this.nowSql = this.isPg ? 'NOW()' : "datetime('now')";
    this.qp = (i: number) => (this.isPg ? `$${i}` : `?`);
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
    await this.clientStatisticsRepository.insert(clientStatistic);
  }

  public async deleteOldStatistics() {
    const now = Date.now();
    const detailCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const halfYearCutoff = new Date(now - 180 * 24 * 60 * 60 * 1000);
    const monthCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // 1) Pool-Aggregate (alle Worker zusammen) für alte Zeitpunkte
    // createdAt/updatedAt via nowSql (dialektsicher)
    const insPoolAgg = `
      INSERT INTO client_statistics_entity (
        address, clientName, sessionId, "time",
        shares, acceptedCount, rejectedCount,
        rejectedJobNotFoundCount, rejectedJobNotFoundDiff1,
        rejectedDuplicateShareCount, rejectedDuplicateShareDiff1,
        rejectedLowDifficultyShareCount, rejectedLowDifficultyShareDiff1,
        "createdAt", "updatedAt"
      )
      SELECT
        'POOL', 'POOL', 'POOL',
        "time",
        SUM(shares),
        SUM(acceptedCount),
        SUM(rejectedCount),
        SUM(rejectedJobNotFoundCount),
        SUM(rejectedJobNotFoundDiff1),
        SUM(rejectedDuplicateShareCount),
        SUM(rejectedDuplicateShareDiff1),
        SUM(rejectedLowDifficultyShareCount),
        SUM(rejectedLowDifficultyShareDiff1),
        ${this.nowSql}, ${this.nowSql}
      FROM client_statistics_entity
      WHERE "time" < ${this.qp(1)}
        AND NOT (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL')
        AND sessionId != 'AGG'
      GROUP BY "time";
    `;
    await this.clientStatisticsRepository.query(insPoolAgg, [
      detailCutoff.getTime(),
    ]);

    // 2) Worker-Aggregate (pro address/clientName) zu einem fixen Bucket-Zeitpunkt (=detailCutoff)
    const insWorkerAgg = `
      INSERT INTO client_statistics_entity (
        address, clientName, sessionId, "time",
        shares, acceptedCount, rejectedCount,
        rejectedJobNotFoundCount, rejectedJobNotFoundDiff1,
        rejectedDuplicateShareCount, rejectedDuplicateShareDiff1,
        rejectedLowDifficultyShareCount, rejectedLowDifficultyShareDiff1,
        "createdAt", "updatedAt"
      )
      SELECT
        address,
        clientName,
        'AGG',
        ${this.qp(1)},
        SUM(shares),
        SUM(acceptedCount),
        SUM(rejectedCount),
        SUM(rejectedJobNotFoundCount),
        SUM(rejectedJobNotFoundDiff1),
        SUM(rejectedDuplicateShareCount),
        SUM(rejectedDuplicateShareDiff1),
        SUM(rejectedLowDifficultyShareCount),
        SUM(rejectedLowDifficultyShareDiff1),
        ${this.nowSql}, ${this.nowSql}
      FROM client_statistics_entity
      WHERE "time" < ${this.qp(2)}
        AND NOT (sessionId = 'AGG' OR (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL'))
      GROUP BY address, clientName;
    `;
    await this.clientStatisticsRepository.query(insWorkerAgg, [
      detailCutoff.getTime(),
      detailCutoff.getTime(),
    ]);

    // 3) Löschläufe (parameterisiert)
    await this.clientStatisticsRepository.query(
      `
      DELETE FROM client_statistics_entity
      WHERE "time" < ${this.qp(1)}
        AND NOT (sessionId = 'AGG' OR (address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL'));
    `,
      [detailCutoff.getTime()],
    );

    await this.clientStatisticsRepository.query(
      `
      DELETE FROM client_statistics_entity
      WHERE "time" < ${this.qp(1)} AND sessionId = 'AGG';
    `,
      [halfYearCutoff.getTime()],
    );

    await this.clientStatisticsRepository.query(
      `
      DELETE FROM client_statistics_entity
      WHERE "time" < ${this.qp(1)} AND address = 'POOL' AND clientName = 'POOL' AND sessionId = 'POOL';
    `,
      [monthCutoff.getTime()],
    );
  }

  public async getChartDataForSite(range: '1d' | '1m' = '1d') {
    const diffDays = range === '1m' ? 30 : 1;
    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;

    const sql = `
      SELECT
        "time" AS label,
        ROUND((SUM(shares) * ${DIFFICULTY_1}) / 600) AS data
      FROM client_statistics_entity AS entry
      WHERE entry."time" > ${this.qp(1)} AND entry.sessionId != 'AGG'
      GROUP BY "time"
      ORDER BY "time"
      LIMIT ${limit};
    `;
    const result: any[] = await this.clientStatisticsRepository.query(sql, [
      since.getTime(),
    ]);

    return result
      .map((r) => ({ ...r, label: new Date(Number(r.label)).toISOString() }))
      .slice(0, Math.max(0, result.length - 1));
  }

  public async getChartDataForAddress(
    address: string,
    range: '1d' | '3d' | '7d' = '1d',
  ) {
    const diffDays = range === '3d' ? 3 : range === '7d' ? 7 : 1;
    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;

    const sql = `
      SELECT
        "time" AS label,
        (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data
      FROM client_statistics_entity AS entry
      WHERE entry.address = ${this.qp(1)} AND entry."time" > ${this.qp(2)}
      GROUP BY "time"
      ORDER BY "time"
      LIMIT ${limit};
    `;

    const result = await this.clientStatisticsRepository.query(sql, [
      address,
      since.getTime(),
    ]);

    return result
      .map((r) => ({ ...r, label: new Date(Number(r.label)).toISOString() }))
      .slice(0, Math.max(0, result.length - 1));
  }

  public async getHashRateForGroup(address: string, clientName: string) {
    const sql = `
      SELECT SUM(shares) AS shares
      FROM client_statistics_entity
      WHERE address = ${this.qp(1)} AND clientName = ${this.qp(2)}
      GROUP BY "time"
      ORDER BY "time" DESC
      LIMIT 2;
    `;
    const result = await this.clientStatisticsRepository.query(sql, [
      address,
      clientName,
    ]);
    if (result.length < 1) return 0;
    const shares = result.reduce((sum, row) => sum + Number(row.shares), 0);
    return this.calcHashRate(shares);
  }

  public async getChartDataForGroup(
    address: string,
    clientName: string,
    range: '1d' | '3d' | '7d' = '1d',
  ) {
    const diffDays = range === '3d' ? 3 : range === '7d' ? 7 : 1;
    const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
    const limit = diffDays * 144;

    const sql = `
      SELECT
        "time" AS label,
        (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data,
        SUM(entry.shares) AS accepted,
        SUM(entry.rejectedJobNotFoundCount) AS rejectedJobNotFound,
        SUM(entry.rejectedJobNotFoundDiff1) AS rejectedJobNotFoundDiff1,
        SUM(entry.rejectedDuplicateShareCount) AS rejectedDuplicatedShare,
        SUM(entry.rejectedDuplicateShareDiff1) AS rejectedDuplicatedShareDiff1,
        SUM(entry.rejectedLowDifficultyShareCount) AS rejectedLowDifficultyShare,
        SUM(entry.rejectedLowDifficultyShareDiff1) AS rejectedLowDifficultyShareDiff1
      FROM client_statistics_entity AS entry
      WHERE entry.address = ${this.qp(1)} AND entry.clientName = ${this.qp(2)} AND entry."time" > ${this.qp(3)}
      GROUP BY "time"
      ORDER BY "time"
      LIMIT ${limit};
    `;
    const result = await this.clientStatisticsRepository.query(sql, [
      address,
      clientName,
      since.getTime(),
    ]);

    const parsed = result.map((res: any) => ({
      label: new Date(Number(res.label)).toISOString(),
      data: res.data == null ? 0 : Number(res.data),
      accepted: Number(res.accepted ?? 0),
      rejectedJobNotFound:
        res.rejectedJobNotFound == null ? 0 : Number(res.rejectedJobNotFound),
      rejectedJobNotFoundDiff1:
        res.rejectedJobNotFoundDiff1 == null
          ? 0
          : Number(res.rejectedJobNotFoundDiff1),
      rejectedDuplicatedShare:
        res.rejectedDuplicatedShare == null
          ? 0
          : Number(res.rejectedDuplicatedShare),
      rejectedDuplicatedShareDiff1:
        res.rejectedDuplicatedShareDiff1 == null
          ? 0
          : Number(res.rejectedDuplicatedShareDiff1),
      rejectedLowDifficultyShare:
        res.rejectedLowDifficultyShare == null
          ? 0
          : Number(res.rejectedLowDifficultyShare),
      rejectedLowDifficultyShareDiff1:
        res.rejectedLowDifficultyShareDiff1 == null
          ? 0
          : Number(res.rejectedLowDifficultyShareDiff1),
    }));

    return parsed.slice(0, Math.max(0, parsed.length - 1));
  }

  public async getHashRateForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const sql = `
      SELECT SUM(shares) AS shares
      FROM client_statistics_entity AS entry
      WHERE entry.address = ${this.qp(1)} AND entry.clientName = ${this.qp(2)} AND entry.sessionId = ${this.qp(3)}
      GROUP BY "time"
      ORDER BY "time" DESC
      LIMIT 2;
    `;
    const result = await this.clientStatisticsRepository.query(sql, [
      address,
      clientName,
      sessionId,
    ]);
    if (result.length < 1) return 0;
    const shares = result.reduce((sum, row) => sum + Number(row.shares), 0);
    return this.calcHashRate(shares);
  }

  public async getChartDataForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const sql = `
      SELECT
        "time" AS label,
        (SUM(shares) * ${DIFFICULTY_1}) / 600 AS data
      FROM client_statistics_entity AS entry
      WHERE entry.address = ${this.qp(1)} AND entry.clientName = ${this.qp(2)} AND entry.sessionId = ${this.qp(3)} AND entry."time" > ${this.qp(4)}
      GROUP BY "time"
      ORDER BY "time"
      LIMIT 144;
    `;
    const result = await this.clientStatisticsRepository.query(sql, [
      address,
      clientName,
      sessionId,
      yesterday.getTime(),
    ]);

    return result
      .map((r: any) => ({ ...r, label: new Date(Number(r.label)).toISOString() }))
      .slice(0, Math.max(0, result.length - 1));
  }

  public async getActiveCountsSince(time: number) {
    const q = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('COUNT(DISTINCT stat.address)', 'addresses')
      .addSelect("COUNT(DISTINCT stat.address || '-' || stat.clientName)", 'workers')
      .addSelect(
        "COUNT(DISTINCT stat.address || '-' || stat.clientName || '-' || stat.sessionId)",
        'sessions',
      )
      .where('stat.time > :since', { since: time })
      .andWhere("stat.sessionId != 'AGG'")
      .andWhere("stat.address != 'POOL'")
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await q.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      addresses: Number(r.addresses),
      workers: Number(r.workers),
      sessions: Number(r.sessions),
    }));
  }

  public async getActiveCountsForAddress(address: string, time: number) {
    const q = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('COUNT(DISTINCT stat.clientName)', 'workers')
      .addSelect("COUNT(DISTINCT stat.clientName || '-' || stat.sessionId)", 'sessions')
      .where('stat.address = :address', { address })
      .andWhere('stat.time > :since', { since: time })
      .andWhere("stat.sessionId != 'AGG'")
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const result = await q.getRawMany();
    return result.map((r) => ({
      time: Number(r.time),
      workers: Number(r.workers),
      sessions: Number(r.sessions),
    }));
  }

  public async getAcceptedEntriesSince(address: string, time: number) {
    const q = this.clientStatisticsRepository
      .createQueryBuilder('stat')
      .select('stat.time', 'time')
      .addSelect('SUM(stat.shares)', 'shares')
      .where('stat.address = :address', { address })
      .andWhere('stat.time > :time', { time })
      .groupBy('stat.time')
      .orderBy('stat.time', 'ASC');

    const rows = await q.getRawMany();
    return rows.map((r) => ({ time: Number(r.time), shares: Number(r.shares) }));
  }

  public async getTotalSharesForAddress(address: string): Promise<number> {
    const row = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('SUM(entry.shares)', 'total')
      .where('entry.address = :address', { address })
      .getRawOne();
    return row?.total ? parseFloat(row.total) : 0;
  }

  public async getTotalSharesForWorkers(address: string) {
    const rows = await this.clientStatisticsRepository
      .createQueryBuilder('entry')
      .select('entry.clientName', 'clientName')
      .addSelect('SUM(entry.shares)', 'total')
      .where('entry.address = :address', { address })
      .groupBy('entry.clientName')
      .getRawMany();
    return rows.map((r) => ({ clientName: r.clientName, total: parseFloat(r.total) }));
  }

  public async deleteAll() {
    return this.clientStatisticsRepository.delete({});
  }
}
