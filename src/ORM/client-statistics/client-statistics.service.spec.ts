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
        { store: {} } as any,
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

    it('aggregates and prunes old statistics while keeping recent data', async () => {
      const repository = dataSource.getRepository(ClientStatisticsEntity);
      const now = Date.now();
      const detailCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).getTime();
      const oldTime = detailCutoff - 60_000;
      const recentTime = detailCutoff + 60_000;

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
            createdAt: new Date(oldTime),
            updatedAt: new Date(oldTime),
          },
          {
            address: 'addr1',
            clientName: 'workerA',
            sessionId: 'sess0002',
            time: oldTime,
            shares: 20,
            acceptedCount: 2,
            rejectedCount: 1,
            rejectedJobNotFoundCount: 1,
            rejectedJobNotFoundDiff1: 1,
            rejectedDuplicateShareCount: 2,
            rejectedDuplicateShareDiff1: 2,
            rejectedLowDifficultyShareCount: 3,
            rejectedLowDifficultyShareDiff1: 3,
            createdAt: new Date(oldTime),
            updatedAt: new Date(oldTime),
          },
          {
            address: 'addr2',
            clientName: 'workerB',
            sessionId: 'sess0003',
            time: oldTime,
            shares: 5,
            acceptedCount: 1,
            rejectedCount: 1,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: new Date(oldTime),
            updatedAt: new Date(oldTime),
          },
          {
            address: 'addr1',
            clientName: 'workerA',
            sessionId: 'sessR001',
            time: recentTime,
            shares: 7,
            acceptedCount: 1,
            rejectedCount: 0,
            rejectedJobNotFoundCount: 0,
            rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0,
            rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0,
            rejectedLowDifficultyShareDiff1: 0,
            createdAt: new Date(recentTime),
            updatedAt: new Date(recentTime),
          },
        ])
        .execute();

      await service.deleteOldStatistics();

      const remaining = await repository.find({
        order: { address: 'ASC', sessionId: 'ASC', time: 'ASC' },
        withDeleted: true,
      });

      const poolAggregate = remaining.find(
        (row) =>
          row.address === 'POOL' &&
          row.clientName === 'POOL' &&
          row.sessionId === 'POOL',
      );
      const workerAggregate = remaining.filter(
        (row) => row.sessionId === 'AGG',
      );
      const recentRow = remaining.find(
        (row) => row.sessionId === 'sessR001',
      );
      const staleSessions = remaining.filter((row) =>
        ['sess0001', 'sess0002', 'sess0003'].includes(row.sessionId),
      );

      expect(poolAggregate).toBeDefined();
      expect(poolAggregate?.time).toBe(oldTime);
      expect(poolAggregate?.shares).toBe(35);
      expect(workerAggregate).toHaveLength(2);
      expect(workerAggregate.map((row) => row.address).sort()).toEqual([
        'addr1',
        'addr2',
      ]);
      const addr1Aggregate = workerAggregate.find(
        (row) => row.address === 'addr1',
      );
      expect(addr1Aggregate?.shares).toBe(30);
      expect(addr1Aggregate?.acceptedCount).toBe(3);
      expect(recentRow).toBeDefined();
      expect(staleSessions).toHaveLength(0);
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
            createdAt: new Date(time),
            updatedAt: new Date(time),
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
  function makeServiceWithMockRedis() {
    const hIncrBy = jest.fn().mockResolvedValue(1);
    const hIncrByFloat = jest.fn().mockResolvedValue(0);
    const expire = jest.fn().mockResolvedValue(1);
    const redisClient = { hIncrBy, hIncrByFloat, expire };

    const repo = { update: jest.fn() } as any;
    const service = new ClientStatisticsService(
      repo,
      {} as any,
      { store: {} } as any,
    );
    (service as any).redisClient = redisClient;
    return { service, redisClient, hIncrBy, hIncrByFloat };
  }

  const dummyClient = {
    address: 'bc1qtest',
    clientName: 'worker1',
    sessionId: 'session-1',
  } as any;

  it("'JobNotFound' reason increments the rejectedJobNotFoundCount + Diff1 buckets", async () => {
    const { service, hIncrBy, hIncrByFloat } = makeServiceWithMockRedis();
    await service.addRejectedShare(dummyClient, 'JobNotFound', 16384);

    // hIncrBy was called for: rejectedCount (total) + rejectedJobNotFoundCount (bucket)
    const buckets = hIncrBy.mock.calls.map((c: any[]) => c[1]);
    expect(buckets).toContain('rejectedCount');
    expect(buckets).toContain('rejectedJobNotFoundCount');
    // hIncrByFloat was called for: rejectedJobNotFoundDiff1
    const diffBuckets = hIncrByFloat.mock.calls.map((c: any[]) => c[1]);
    expect(diffBuckets).toContain('rejectedJobNotFoundDiff1');
  });

  it("'Stale' reason ALSO increments the rejectedJobNotFoundCount + Diff1 buckets (conflation)", async () => {
    const { service, hIncrBy, hIncrByFloat } = makeServiceWithMockRedis();
    await service.addRejectedShare(dummyClient, 'Stale', 16384);

    const buckets = hIncrBy.mock.calls.map((c: any[]) => c[1]);
    expect(buckets).toContain('rejectedCount');
    // CRITICAL: 'Stale' lands in the JobNotFound per-worker bucket so the
    // UI continues to display "code 21" rejections under one header.
    expect(buckets).toContain('rejectedJobNotFoundCount');
    const diffBuckets = hIncrByFloat.mock.calls.map((c: any[]) => c[1]);
    expect(diffBuckets).toContain('rejectedJobNotFoundDiff1');
  });

  it("'DuplicateShare' / 'LowDifficultyShare' route to their dedicated buckets", async () => {
    const { service, hIncrBy } = makeServiceWithMockRedis();
    await service.addRejectedShare(dummyClient, 'DuplicateShare', 16384);
    await service.addRejectedShare(dummyClient, 'LowDifficultyShare', 16384);

    const buckets = hIncrBy.mock.calls.map((c: any[]) => c[1]);
    expect(buckets).toContain('rejectedDuplicateShareCount');
    expect(buckets).toContain('rejectedLowDifficultyShareCount');
    // And NOT into JobNotFound (no cross-pollination from the Stale fix)
    const jobNotFoundCalls = buckets.filter((b: string) => b === 'rejectedJobNotFoundCount');
    expect(jobNotFoundCalls.length).toBe(0);
  });

  it("unknown reason falls through: only rejectedCount (total) increments, no per-reason bucket", async () => {
    const { service, hIncrBy, hIncrByFloat } = makeServiceWithMockRedis();
    await service.addRejectedShare(dummyClient, 'OtherUnknown', 16384);

    const buckets = hIncrBy.mock.calls.map((c: any[]) => c[1]);
    expect(buckets).toContain('rejectedCount');
    expect(buckets).not.toContain('rejectedJobNotFoundCount');
    expect(buckets).not.toContain('rejectedDuplicateShareCount');
    expect(buckets).not.toContain('rejectedLowDifficultyShareCount');
    expect(hIncrByFloat).not.toHaveBeenCalled();
  });
});
