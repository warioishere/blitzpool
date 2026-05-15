import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

jest.setTimeout(60000);

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientStatisticsService } from './client-statistics.service';

const FIXED_NOW = new Date('2024-01-08T00:00:00Z');

async function createDataSource(driver: 'sqlite' | 'postgres'): Promise<DataSource> {
  if (driver === 'sqlite') {
    const dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      dropSchema: true,
      synchronize: true,
      entities: [ClientStatisticsEntity],
    });

    await dataSource.initialize();
    return dataSource;
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'pg_mem',
  });
  db.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'pg-mem',
  });

  const dataSource = db.adapters.createTypeormDataSource({
    type: 'postgres',
    database: 'pg-mem',
    synchronize: true,
    entities: [ClientStatisticsEntity],
  });

  await dataSource.initialize();
  return dataSource;
}

describe.each(['sqlite', 'postgres'] as const)(
  'ClientStatisticsService portability (%s)',
  (driver) => {
    let dataSource: DataSource;
    let service: ClientStatisticsService;
    let dateNowSpy: jest.SpyInstance<number, []>;

    beforeAll(async () => {
      dataSource = await createDataSource(driver);
      service = new ClientStatisticsService(
        dataSource.getRepository(ClientStatisticsEntity),
        {} as any,
        dataSource,
      );
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    beforeEach(async () => {
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW.getTime());
      await dataSource.getRepository(ClientStatisticsEntity).clear();
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
    });

    it('deletes rows older than 14 days, keeps anything younger', async () => {
      const repository = dataSource.getRepository(ClientStatisticsEntity);
      const now = Date.now();
      const cutoff = new Date(now - 14 * 24 * 60 * 60 * 1000).getTime();
      const oldTime = cutoff - 60_000;       // 14d + 1m old → DELETE
      const insideRetention = cutoff + 60_000; // 14d - 1m old → KEEP

      await repository
        .createQueryBuilder()
        .insert()
        .values([
          {
            address: 'addr1',
            clientName: 'workerA',
            sessionId: 'sess0001',
            time: oldTime,
            shares: 10,
            acceptedCount: 1,
            rejectedCount: 0,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: oldTime,
            updatedAt: oldTime,
          },
          {
            address: 'addr1',
            clientName: 'workerA',
            sessionId: 'sessR001',
            time: insideRetention,
            shares: 7,
            acceptedCount: 1,
            rejectedCount: 0,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: insideRetention,
            updatedAt: insideRetention,
          },
        ])
        .execute();

      await service.deleteOldStatistics();

      const remaining = await repository.find({ withDeleted: true });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('sessR001');
    });

    it('provides chart data without relying on sqlite syntax', async () => {
      const repository = dataSource.getRepository(ClientStatisticsEntity);
      const now = Date.now();
      const timestamps = [
        now - 3 * 60 * 1000,
        now - 2 * 60 * 1000,
        now - 60 * 1000,
      ];

      await repository
        .createQueryBuilder()
        .insert()
        .values(
          timestamps.map((time) => ({
            address: 'chart-addr',
            clientName: 'chart-worker',
            sessionId: 'chart001',
            time,
            shares: 1,
            acceptedCount: 1,
            rejectedCount: 0,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: time,
            updatedAt: time,
          })),
        )
        .execute();

      const chartData = await service.getChartDataForGroup(
        'chart-addr',
        'chart-worker',
        '1d',
      );
      const hashRate = await service.getHashRateForSession(
        'chart-addr',
        'chart-worker',
        'chart001',
      );

      expect(chartData.length).toBeGreaterThan(0);
      chartData.forEach((point) => {
        expect(typeof point.label).toBe('string');
        expect(typeof point.data).toBe('number');
      });
      expect(hashRate).toBeGreaterThan(0);
    });

    it('deleteOldStatistics is idempotent — back-to-back runs do not throw', async () => {
      const repository = dataSource.getRepository(ClientStatisticsEntity);
      const now = Date.now();
      const oldTime = now - 14 * 24 * 60 * 60 * 1000 - 60_000;

      await repository
        .createQueryBuilder()
        .insert()
        .values([
          {
            address: 'addr1',
            clientName: 'workerA',
            sessionId: 'sess0001',
            time: oldTime,
            shares: 10,
            acceptedCount: 1,
            rejectedCount: 0,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: oldTime,
            updatedAt: oldTime,
          },
        ])
        .execute();

      await expect(service.deleteOldStatistics()).resolves.toBeUndefined();
      await expect(service.deleteOldStatistics()).resolves.toBeUndefined();

      const remaining = await repository.find({ withDeleted: true });
      expect(remaining).toHaveLength(0);
    });
  },
);

/**
 * Per-worker rejection-counter conflation: the per-worker statistics use
 * a fixed SQL schema with three reason-specific columns (JobNotFound,
 * DuplicateShare, LowDifficultyShare). The new `'Stale'` reason
 * (introduced with the ckpool-style retire-then-age refactor for the
 * stratum jobs lifecycle) doesn't have its own column. We deliberately
 * conflate `'Stale'` INTO the JobNotFound bucket on the per-worker
 * counter so the UI's `rejectedJobNotFound` field continues to mean
 * "share rejected with wire code 21" — both `JobNotFound` and `Stale`
 * emit code 21 over SV1, which is what the per-worker counter
 * historically tracked. Pool-wide and per-address counters keep them
 * distinct (those use a schemaless reason field).
 */
describe('ClientStatisticsService — addRejectedShare per-worker reason buckets (Stale conflation)', () => {
  function makeService() {
    const repo = { update: jest.fn() } as any;
    return new ClientStatisticsService(repo, {} as any, {} as any);
  }

  const dummyClient = {
    address: 'bc1qtest',
    clientName: 'worker1',
    sessionId: 'session-1',
  } as any;

  function bucketOf(svc: ClientStatisticsService) {
    const out = svc.drainDeltas();
    expect(out.length).toBe(1);
    return out[0];
  }

  it("'JobNotFound' reason increments the rejectedJobNotFoundCount + Diff1 fields", async () => {
    const svc = makeService();
    await svc.addRejectedShare(dummyClient, 'JobNotFound', 16384);
    const b = bucketOf(svc);
    expect(b.rejectedCount).toBe(1);
    expect(b.rejectedJobNotFoundCount).toBe(1);
    expect(b.rejectedJobNotFoundDiff1).toBe(16384);
  });

  it("'Stale' reason ALSO increments the rejectedJobNotFoundCount + Diff1 fields (conflation)", async () => {
    const svc = makeService();
    await svc.addRejectedShare(dummyClient, 'Stale', 16384);
    const b = bucketOf(svc);
    expect(b.rejectedCount).toBe(1);
    // CRITICAL: 'Stale' lands in the JobNotFound per-worker bucket so the
    // UI continues to display "code 21" rejections under one header.
    expect(b.rejectedJobNotFoundCount).toBe(1);
    expect(b.rejectedJobNotFoundDiff1).toBe(16384);
  });

  it("'DuplicateShare' / 'LowDifficultyShare' route to their dedicated buckets", async () => {
    const svc = makeService();
    await svc.addRejectedShare(dummyClient, 'DuplicateShare', 16384);
    await svc.addRejectedShare(dummyClient, 'LowDifficultyShare', 16384);
    const b = bucketOf(svc);
    expect(b.rejectedDuplicateShareCount).toBe(1);
    expect(b.rejectedDuplicateShareDiff1).toBe(16384);
    expect(b.rejectedLowDifficultyShareCount).toBe(1);
    expect(b.rejectedLowDifficultyShareDiff1).toBe(16384);
    // And NOT into JobNotFound (no cross-pollination from the Stale fix)
    expect(b.rejectedJobNotFoundCount).toBe(0);
  });

  it("unknown reason falls through: only rejectedCount (total) increments, no per-reason bucket", async () => {
    const svc = makeService();
    await svc.addRejectedShare(dummyClient, 'OtherUnknown', 16384);
    const b = bucketOf(svc);
    expect(b.rejectedCount).toBe(1);
    expect(b.rejectedJobNotFoundCount).toBe(0);
    expect(b.rejectedDuplicateShareCount).toBe(0);
    expect(b.rejectedLowDifficultyShareCount).toBe(0);
  });
});
