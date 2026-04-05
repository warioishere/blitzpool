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
