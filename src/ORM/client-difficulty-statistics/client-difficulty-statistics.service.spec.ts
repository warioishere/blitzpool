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

  it('stores the highest difficulty per slot and aggregates by address', async () => {
    const base = Date.UTC(2023, 0, 1, 12, 15, 0, 0);

    await service.recordShareDifficulty({
      address: 'addr1',
      clientName: 'workerA',
      timestamp: base,
      difficulty: 100,
    });

    await service.recordShareDifficulty({
      address: 'addr1',
      clientName: 'workerA',
      timestamp: base + 10_000,
      difficulty: 80,
    });

    await service.recordShareDifficulty({
      address: 'addr1',
      clientName: 'workerA',
      timestamp: base + 20_000,
      difficulty: 120,
    });

    await service.recordShareDifficulty({
      address: 'addr1',
      clientName: 'workerB',
      timestamp: base + 30_000,
      difficulty: 140,
    });

    const slotTime = Math.floor(base / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const entries = await service.getMaximaForAddress('addr1', slotTime, slotTime);

    expect(entries).toEqual([
      { slotTime, maxDifficulty: 140 },
    ]);
  });

  it('purges records older than the configured cutoff', async () => {
    const oldSlot = Date.UTC(2023, 0, 1, 0, 0, 0, 0);
    const newSlot = Date.UTC(2023, 0, 2, 0, 0, 0, 0);

    await service.recordShareDifficulty({
      address: 'addr1',
      timestamp: oldSlot,
      difficulty: 10,
    });

    await service.recordShareDifficulty({
      address: 'addr1',
      timestamp: newSlot,
      difficulty: 20,
    });

    await service.deleteOlderThan(newSlot);

    const rows = await dataSource
      .getRepository(ClientDifficultyStatisticsEntity)
      .find({ order: { slotTime: 'ASC' } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slotTime: newSlot, maxDifficulty: 20 });
  });
});
