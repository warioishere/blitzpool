import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { BestDifficultyTrackerEntity } from './best-difficulty-tracker.entity';
import { BestDifficultyTrackerService } from './best-difficulty-tracker.service';

jest.setTimeout(30000);

async function createPgDataSource(): Promise<DataSource> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'pg_mem' });
  db.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'pg-mem' });

  const ds = db.adapters.createTypeormDataSource({
    type: 'postgres',
    database: 'pg-mem',
    synchronize: true,
    entities: [BestDifficultyTrackerEntity],
  });
  await ds.initialize();
  return ds;
}

describe('BestDifficultyTrackerService (postgres)', () => {
  let dataSource: DataSource;
  let service: BestDifficultyTrackerService;

  beforeAll(async () => {
    dataSource = await createPgDataSource();
    service = new BestDifficultyTrackerService(
      dataSource.getRepository(BestDifficultyTrackerEntity),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(BestDifficultyTrackerEntity).clear();
  });

  it('inserts a new tracker via upsert', async () => {
    await service.updateTracker('addr1', 100);

    const tracker = await service.getTracker('addr1');
    expect(tracker).toBeDefined();
    expect(tracker!.address).toBe('addr1');
    expect(tracker!.bestDifficulty).toBe(100);
    expect(tracker!.lastCheckedAt).toBeGreaterThan(0);
  });

  it('updates an existing tracker via upsert (single query, no findOne)', async () => {
    await service.updateTracker('addr1', 100);
    await service.updateTracker('addr1', 200);

    const tracker = await service.getTracker('addr1');
    expect(tracker!.bestDifficulty).toBe(200);
  });

  it('handles concurrent upserts without race conditions', async () => {
    await Promise.all([
      service.updateTracker('addr1', 50),
      service.updateTracker('addr1', 75),
    ]);

    const tracker = await service.getTracker('addr1');
    expect(tracker).toBeDefined();
    // One of the two values wins — no error thrown
    expect([50, 75]).toContain(tracker!.bestDifficulty);
  });

  it('resets tracker without findOne', async () => {
    await service.updateTracker('addr1', 500);
    await service.resetTracker('addr1');

    const tracker = await service.getTracker('addr1');
    expect(tracker!.bestDifficulty).toBe(0);
  });

  it('resetTracker is a no-op for missing address', async () => {
    // Should not throw
    await service.resetTracker('nonexistent');
  });

  it('deleteTracker removes the record', async () => {
    await service.updateTracker('addr1', 100);
    await service.deleteTracker('addr1');

    const tracker = await service.getTracker('addr1');
    expect(tracker).toBeNull();
  });
});

// ── Real-Postgres integration ─────────────────────────────────────────
//
// PG_E2E=1 enables this block. The existing suite uses pg-mem which is
// type-permissive; real PG enforces bigint strictly on the
// createdAt/updatedAt columns set by the createQueryBuilder().insert()
// path. See memory/feedback-pg-e2e-tests.md for container setup.
const PG_E2E_BDT = process.env.PG_E2E === '1';
const describeIfBdt = PG_E2E_BDT ? describe : describe.skip;

describeIfBdt('BestDifficultyTrackerService — real Postgres', () => {
  let dataSource: DataSource;
  let service: BestDifficultyTrackerService;

  beforeAll(async () => {
    const { TrackedEntityTimestampSubscriber } = require('../utils/tracked-entity.subscriber');
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.PG_HOST ?? 'localhost',
      port: parseInt(process.env.PG_PORT ?? '15432', 10),
      username: process.env.PG_USER ?? 'postgres',
      password: process.env.PG_PASSWORD ?? 'postgres',
      database: process.env.PG_DATABASE ?? 'blitzpool_test',
      entities: [BestDifficultyTrackerEntity],
      subscribers: [TrackedEntityTimestampSubscriber],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();
    service = new BestDifficultyTrackerService(
      dataSource.getRepository(BestDifficultyTrackerEntity),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(BestDifficultyTrackerEntity).clear();
  });

  it('updateTracker upsert lands createdAt/updatedAt as bigint', async () => {
    const beforeMs = Date.now();
    await service.updateTracker('addr1', 100);
    const afterMs = Date.now();

    const tracker = await service.getTracker('addr1');
    expect(tracker).not.toBeNull();
    expect(typeof tracker!.createdAt).toBe('number');
    expect(typeof tracker!.updatedAt).toBe('number');
    expect(tracker!.createdAt).toBeGreaterThanOrEqual(beforeMs);
    expect(tracker!.createdAt).toBeLessThanOrEqual(afterMs);
    expect(tracker!.lastCheckedAt).toBeGreaterThanOrEqual(beforeMs);
  });

  it('upsert preserves createdAt on conflict, updates lastCheckedAt', async () => {
    await service.updateTracker('addr1', 100);
    const firstCreatedAt = (await service.getTracker('addr1'))!.createdAt!;

    await new Promise(r => setTimeout(r, 5));    // ensure clock moves

    await service.updateTracker('addr1', 200);
    const t2 = await service.getTracker('addr1');

    expect(t2!.bestDifficulty).toBe(200);
    expect(t2!.createdAt).toBe(firstCreatedAt);  // preserved on conflict
    expect(t2!.lastCheckedAt).toBeGreaterThan(firstCreatedAt);
  });
});
