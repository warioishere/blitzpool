import { DataSource } from 'typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';
import { PoolShareStatisticsService } from './pool-share-statistics.service';

describe('PoolShareStatisticsService', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [PoolShareStatisticsEntity],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('adds deltas to an existing bucket on each flush', async () => {
    const repository = dataSource.getRepository(PoolShareStatisticsEntity);
    const service = new PoolShareStatisticsService(repository as any);

    const tenMinutes = 1000 * 60 * 10;
    const baseTimestamp = 1700000000000;
    const timeSlot = Math.floor(baseTimestamp / tenMinutes) * tenMinutes;

    await repository.insert({
      time: timeSlot,
      accepted: 100,
      rejected: 5,
    });

    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(baseTimestamp + 5_000);

    try {
      await service.addAcceptedShare(3);
      await service.addRejectedShare(2);
      await (service as any).flush();

      let row = await repository.findOneBy({ time: timeSlot });
      expect(row).toMatchObject({ accepted: 103, rejected: 7 });

      await service.addAcceptedShare(4);
      await service.addRejectedShare(1);
      await (service as any).flush();

      row = await repository.findOneBy({ time: timeSlot });
      expect(row).toMatchObject({ accepted: 107, rejected: 8 });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
