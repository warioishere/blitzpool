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
