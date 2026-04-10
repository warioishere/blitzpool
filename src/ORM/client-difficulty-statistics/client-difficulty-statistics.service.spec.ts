import { DataSource } from 'typeorm';

import { ClientDifficultyStatisticsEntity } from './client-difficulty-statistics.entity';
import { ClientDifficultyStatisticsService } from './client-difficulty-statistics.service';

describe('ClientDifficultyStatisticsService', () => {
  let dataSource: DataSource;
  let service: ClientDifficultyStatisticsService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [ClientDifficultyStatisticsEntity],
      synchronize: true,
    });
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

    // Not in DB yet — only buffered
    let count = await repository.count();
    expect(count).toBe(0);

    // Flush to DB
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

    // First flush with high value
    await service.recordShareDifficulty({
      address: 'addr1', clientName: 'workerA', timestamp, difficulty: 100,
    });
    await service.flushBuffer();

    // Second flush with lower value — DB should keep 100
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
    // Should not throw
    await service.flushBuffer();
  });

  it('re-buffers records on flush failure', async () => {
    // Use a service with a broken repository
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

      // Record should be re-buffered — flush again to verify it's still there
      expect(brokenRepo.query).toHaveBeenCalledTimes(1);
      brokenRepo.query.mockClear();

      await brokenService.flushBuffer();
      expect(brokenRepo.query).toHaveBeenCalledTimes(1); // Tried again
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
