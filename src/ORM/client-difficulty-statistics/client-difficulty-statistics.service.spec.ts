import { DataSource } from 'typeorm';

import { ClientDifficultyStatisticsEntity } from './client-difficulty-statistics.entity';
import { ClientDifficultyStatisticsService } from './client-difficulty-statistics.service';
import { TrackedEntityTimestampSubscriber } from '../utils/tracked-entity.subscriber';

// PG_E2E=1 enables the real-Postgres path. The 2026-05 bigint cleanup
// broke `flushPostgres` (passing `new Date()` to a bigint column), and
// the sqlite-only spec didn't catch it because SQLite is permissive
// about type coercion. Running this spec against the real Postgres
// container catches PG-only type strictness issues.
//
// Container: `docker run -d --name blitzpool-test-pg -p 15432:5432 \
//   -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
//   -e POSTGRES_DB=blitzpool_test postgres:18`
const PG_E2E = process.env.PG_E2E === '1';
const drivers = PG_E2E ? (['sqlite', 'postgres'] as const) : (['sqlite'] as const);

describe.each(drivers)('ClientDifficultyStatisticsService (%s)', (driver) => {
  let dataSource: DataSource;
  let service: ClientDifficultyStatisticsService;

  beforeEach(async () => {
    if (driver === 'sqlite') {
      dataSource = new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: [ClientDifficultyStatisticsEntity],
        subscribers: [TrackedEntityTimestampSubscriber],
        synchronize: true,
      });
    } else {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.PG_HOST ?? 'localhost',
        port: parseInt(process.env.PG_PORT ?? '15432', 10),
        username: process.env.PG_USER ?? 'postgres',
        password: process.env.PG_PASSWORD ?? 'postgres',
        database: process.env.PG_DATABASE ?? 'blitzpool_test',
        entities: [ClientDifficultyStatisticsEntity],
        subscribers: [TrackedEntityTimestampSubscriber],
        synchronize: true,
        dropSchema: true,
      });
    }
    await dataSource.initialize();
    service = new ClientDifficultyStatisticsService(
      dataSource.getRepository(ClientDifficultyStatisticsEntity) as any,
    );
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('buffers records in-memory and flushes to DB', async () => {
    const timestamp = Date.UTC(2023, 0, 1, 12, 0, 0, 0);
    const slotTime = Math.floor(timestamp / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const repository = dataSource.getRepository(ClientDifficultyStatisticsEntity);

    await service.recordShareDifficulty({
      address: 'addr1',
      clientName: 'workerA',
      timestamp,
      difficulty: 50,
    });

    let count = await repository.count();
    expect(count).toBe(0);

    await service.flushBuffer();

    count = await repository.count();
    expect(count).toBe(1);

    const record = await repository.findOneByOrFail({
      address: 'addr1',
      clientName: 'workerA',
      slotTime,
    });
    expect(record.maxDifficulty).toBe(50);
  });

  it('keeps only the maximum difficulty per key in buffer', async () => {
    const timestamp = Date.UTC(2023, 0, 1, 12, 0, 0, 0);
    const slotTime = Math.floor(timestamp / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const repository = dataSource.getRepository(ClientDifficultyStatisticsEntity);

    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp, difficulty: 50,
    });
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: timestamp + 5_000, difficulty: 40,
    });
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: timestamp + 10_000, difficulty: 90,
    });

    await service.flushBuffer();

    const record = await repository.findOneByOrFail({
      address: 'addr1', clientName: 'workerA', slotTime,
    });
    expect(record.maxDifficulty).toBe(90);
  });

  it('upserts correctly when DB already has a higher value', async () => {
    const timestamp = Date.UTC(2023, 0, 1, 12, 0, 0, 0);
    const slotTime = Math.floor(timestamp / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const repository = dataSource.getRepository(ClientDifficultyStatisticsEntity);

    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp, difficulty: 100,
    });
    await service.flushBuffer();

    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: timestamp + 5_000, difficulty: 50,
    });
    await service.flushBuffer();

    const record = await repository.findOneByOrFail({
      address: 'addr1', clientName: 'workerA', slotTime,
    });
    expect(record.maxDifficulty).toBe(100);
  });

  it('stores the highest difficulty per slot and aggregates by address', async () => {
    const base = Date.UTC(2023, 0, 1, 12, 15, 0, 0);

    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: base, difficulty: 100,
    });
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: base + 10_000, difficulty: 80,
    });
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp: base + 20_000, difficulty: 120,
    });
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerB', timestamp: base + 30_000, difficulty: 140,
    });

    await service.flushBuffer();

    const slotTime = Math.floor(base / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const entries = await service.getMaximaForAddress('addr1', slotTime, slotTime);

    expect(entries).toEqual([
      { slotTime, maxDifficulty: 140 },
    ]);
  });

  it('purges records older than the configured cutoff', async () => {
    const oldSlot = Date.UTC(2023, 0, 1, 0, 0, 0, 0);
    const newSlot = Date.UTC(2023, 0, 2, 0, 0, 0, 0);

    await service.recordShareDifficulty({ address: 'addr1', timestamp: oldSlot, difficulty: 10 });
    await service.recordShareDifficulty({ address: 'addr1', timestamp: newSlot, difficulty: 20 });
    await service.flushBuffer();

    await service.deleteOlderThan(newSlot);

    const rows = await dataSource
      .getRepository(ClientDifficultyStatisticsEntity)
      .find({ order: { slotTime: 'ASC' } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slotTime: newSlot, maxDifficulty: 20 });
  });

  it('does not flush when buffer is empty', async () => {
    await service.flushBuffer();
  });

  it('re-buffers records on flush failure', async () => {
    const brokenRepo = {
      manager: { connection: { options: { type: 'sqlite' } } },
      metadata: { tableName: 'nonexistent_table' },
      query: jest.fn().mockRejectedValue(new Error('DB error')),
    };
    const brokenService = new ClientDifficultyStatisticsService(brokenRepo as any);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    try {
      await brokenService.recordShareDifficulty({
        address: 'addr1', clientName: 'w', timestamp: Date.now(), difficulty: 50,
      });

      await brokenService.flushBuffer();

      expect(brokenRepo.query).toHaveBeenCalledTimes(1);
      brokenRepo.query.mockClear();

      await brokenService.flushBuffer();
      expect(brokenRepo.query).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
