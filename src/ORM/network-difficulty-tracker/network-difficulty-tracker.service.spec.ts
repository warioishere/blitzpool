import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { NetworkDifficultyTrackerEntity } from './network-difficulty-tracker.entity';
import { NetworkDifficultyTrackerService } from './network-difficulty-tracker.service';

jest.setTimeout(30000);

async function createPgDataSource(): Promise<DataSource> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'pg_mem' });
  db.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'pg-mem' });

  const ds = db.adapters.createTypeormDataSource({
    type: 'postgres',
    database: 'pg-mem',
    synchronize: true,
    entities: [NetworkDifficultyTrackerEntity],
  });
  await ds.initialize();
  return ds;
}

describe('NetworkDifficultyTrackerService (postgres)', () => {
  let dataSource: DataSource;
  let service: NetworkDifficultyTrackerService;

  beforeAll(async () => {
    dataSource = await createPgDataSource();
    service = new NetworkDifficultyTrackerService(
      dataSource.getRepository(NetworkDifficultyTrackerEntity),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(NetworkDifficultyTrackerEntity).clear();
  });

  it('creates tracker on first call (no difficultyChanged)', async () => {
    await service.updateTracker(1000);

    const tracker = await service.getTracker();
    expect(tracker).toBeDefined();
    expect(tracker!.id).toBe(1);
    expect(tracker!.currentDifficulty).toBe(1000);
    expect(tracker!.previousDifficulty).toBeNull();
    expect(tracker!.lastCheckedAt).toBeGreaterThan(0);
    expect(tracker!.lastChangedAt).toBeNull();
  });

  it('updates lastCheckedAt without changing difficulty', async () => {
    const before = Date.now();
    await service.updateTracker(1000);
    const tracker1 = await service.getTracker();

    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    await service.updateTracker(1000);
    const tracker2 = await service.getTracker();

    expect(tracker2!.currentDifficulty).toBe(1000);
    expect(tracker2!.lastCheckedAt).toBeGreaterThanOrEqual(tracker1!.lastCheckedAt);
  });

  it('shifts current→previous when difficultyChanged=true', async () => {
    await service.updateTracker(1000);
    await service.updateTracker(2000, true);

    const tracker = await service.getTracker();
    expect(tracker!.currentDifficulty).toBe(2000);
    expect(tracker!.previousDifficulty).toBe(1000);
    expect(tracker!.lastChangedAt).toBeGreaterThan(0);
  });

  it('creates with difficultyChanged=true on empty table', async () => {
    await service.updateTracker(5000, true);

    const tracker = await service.getTracker();
    expect(tracker).toBeDefined();
    expect(tracker!.currentDifficulty).toBe(5000);
    // previousDifficulty is NULL because there was no previous row
    // (ON CONFLICT sets it to the old currentDifficulty, but on INSERT it's NULL)
    expect(tracker!.lastChangedAt).toBeGreaterThan(0);
  });

  it('handles multiple difficulty changes correctly', async () => {
    await service.updateTracker(1000);
    await service.updateTracker(2000, true);
    await service.updateTracker(3000, true);

    const tracker = await service.getTracker();
    expect(tracker!.currentDifficulty).toBe(3000);
    expect(tracker!.previousDifficulty).toBe(2000);
  });
});

// ── Real-Postgres integration ─────────────────────────────────────────
//
// PG_E2E=1 enables this block. The raw INSERT ... ON CONFLICT path
// for difficultyChanged=true passes `now` (number) for both
// "createdAt"/"updatedAt"/"lastCheckedAt"/"lastChangedAt" — all bigint
// now. pg-mem can't catch the type-strict mismatch reliably.
const PG_E2E_NDT = process.env.PG_E2E === '1';
const describeIfNdt = PG_E2E_NDT ? describe : describe.skip;

describeIfNdt('NetworkDifficultyTrackerService — real Postgres', () => {
  let dataSource: DataSource;
  let service: NetworkDifficultyTrackerService;

  beforeAll(async () => {
    const { TrackedEntityTimestampSubscriber } = require('../utils/tracked-entity.subscriber');
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.PG_HOST ?? 'localhost',
      port: parseInt(process.env.PG_PORT ?? '15432', 10),
      username: process.env.PG_USER ?? 'postgres',
      password: process.env.PG_PASSWORD ?? 'postgres',
      database: process.env.PG_DATABASE ?? 'blitzpool_test',
      entities: [NetworkDifficultyTrackerEntity],
      subscribers: [TrackedEntityTimestampSubscriber],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();
    service = new NetworkDifficultyTrackerService(
      dataSource.getRepository(NetworkDifficultyTrackerEntity),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(NetworkDifficultyTrackerEntity).clear();
  });

  it('first updateTracker writes bigint timestamps via createQueryBuilder().insert()', async () => {
    const before = Date.now();
    await service.updateTracker(1000);
    const tracker = await service.getTracker();

    expect(typeof tracker!.createdAt).toBe('number');
    expect(typeof tracker!.updatedAt).toBe('number');
    expect(typeof tracker!.lastCheckedAt).toBe('number');
    expect(tracker!.lastCheckedAt).toBeGreaterThanOrEqual(before);
  });

  it('difficultyChanged=true raw INSERT path sets all 4 timestamp columns as bigint', async () => {
    await service.updateTracker(1000);
    const before = Date.now();
    await service.updateTracker(2000, true);

    const tracker = await service.getTracker();
    expect(tracker!.currentDifficulty).toBe(2000);
    expect(typeof tracker!.lastChangedAt).toBe('number');
    expect(typeof tracker!.updatedAt).toBe('number');
    expect(tracker!.lastChangedAt!).toBeGreaterThanOrEqual(before);
  });
});
