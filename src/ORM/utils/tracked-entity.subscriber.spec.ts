import { DataSource, Entity, PrimaryColumn, Column } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { TrackedEntity } from './TrackedEntity.entity';
import { TrackedEntityTimestampSubscriber } from './tracked-entity.subscriber';

jest.setTimeout(30000);

@Entity()
class SampleEntity extends TrackedEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  @Column({ type: 'double precision', default: 0 })
  value: number;
}

async function makeDataSource(): Promise<DataSource> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'pg_mem' });
  db.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'pg-mem' });

  const ds = db.adapters.createTypeormDataSource({
    type: 'postgres',
    database: 'pg-mem',
    synchronize: true,
    entities: [SampleEntity],
    subscribers: [TrackedEntityTimestampSubscriber],
  });
  await ds.initialize();
  return ds;
}

describe('TrackedEntityTimestampSubscriber', () => {
  let dataSource: DataSource;
  let repo: ReturnType<DataSource['getRepository']>;

  beforeAll(async () => {
    dataSource = await makeDataSource();
    repo = dataSource.getRepository(SampleEntity);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  describe('beforeInsert (existing behaviour)', () => {
    it('auto-fills createdAt + updatedAt when caller omits them', async () => {
      const before = Date.now();
      await repo.save({ id: 'a', value: 1 });
      const after = Date.now();

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(typeof row.createdAt).toBe('number');
      expect(typeof row.updatedAt).toBe('number');
      expect(row.createdAt!).toBeGreaterThanOrEqual(before);
      expect(row.createdAt!).toBeLessThanOrEqual(after);
    });

    it('respects caller-supplied createdAt / updatedAt on insert', async () => {
      const fixed = 1_700_000_000_000;
      await repo.save({ id: 'a', value: 1, createdAt: fixed, updatedAt: fixed });

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(row.createdAt).toBe(fixed);
      expect(row.updatedAt).toBe(fixed);
    });
  });

  describe('beforeUpdate (regression-guard for the @UpdateDateColumn replacement)', () => {
    it('bumps updatedAt on repo.update() when caller omits it', async () => {
      // Seed
      await repo.save({ id: 'a', value: 1 });
      const seeded = await repo.findOneOrFail({ where: { id: 'a' } });
      const seedUpdatedAt = seeded.updatedAt!;

      await new Promise(r => setTimeout(r, 50)); // ensure clock advances

      // Caller updates a single column without touching updatedAt.
      // Pre-fix: updatedAt stays stale → reproduces the /api/info bug.
      // Post-fix: subscriber bumps updatedAt to "now".
      await repo.update({ id: 'a' }, { value: 42 });

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(row.value).toBe(42);
      expect(row.updatedAt!).toBeGreaterThan(seedUpdatedAt);
    });

    it('respects caller-supplied updatedAt on repo.update()', async () => {
      await repo.save({ id: 'a', value: 1 });

      const explicitTimestamp = 1_700_000_000_000;
      await repo.update({ id: 'a' }, { value: 42, updatedAt: explicitTimestamp });

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(row.updatedAt).toBe(explicitTimestamp);
    });

    it('bumps updatedAt on repo.save() when caller passes a partial without it', async () => {
      const seeded = await repo.save({ id: 'a', value: 1 });
      const seedUpdatedAt = seeded.updatedAt!;
      await new Promise(r => setTimeout(r, 50));

      await repo.save({ id: 'a', value: 99 });

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(row.value).toBe(99);
      expect(row.updatedAt!).toBeGreaterThan(seedUpdatedAt);
    });

    // Load → modify → save(entityInstance) is the pattern that matches the
    // PushSubscriptionService.subscribe() flow. The loaded entity carries
    // updatedAt from the DB, so the subscriber must still bump it on save
    // to match the original @UpdateDateColumn semantics.
    it('bumps updatedAt on repo.save(loadedEntity) — load + modify + save pattern', async () => {
      await repo.save({ id: 'a', value: 1 });
      const loaded = await repo.findOneOrFail({ where: { id: 'a' } });
      const loadedUpdatedAt = loaded.updatedAt!;
      await new Promise(r => setTimeout(r, 50));

      loaded.value = 99;
      await repo.save(loaded);

      const row = await repo.findOneOrFail({ where: { id: 'a' } });
      expect(row.value).toBe(99);
      expect(row.updatedAt!).toBeGreaterThan(loadedUpdatedAt);
    });
  });
});
