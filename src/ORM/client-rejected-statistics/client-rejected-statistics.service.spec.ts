import { DataSource } from 'typeorm';

import { ClientRejectedStatisticsEntity } from './client-rejected-statistics.entity';
import { ClientRejectedStatisticsService } from './client-rejected-statistics.service';

describe('ClientRejectedStatisticsService', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [ClientRejectedStatisticsEntity],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('accumulates deltas when flushing over an existing row', async () => {
    const repository = dataSource.getRepository(ClientRejectedStatisticsEntity);
    const service = new ClientRejectedStatisticsService(repository as any);

    const tenMinutes = 1000 * 60 * 10;
    const now = 1700000000000;
    const timeSlot = Math.floor(now / tenMinutes) * tenMinutes;

    await repository.insert({
      address: 'addr',
      reason: 'duplicate',
      time: timeSlot,
      count: 10,
      shares: 100,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(timeSlot + 5_000);

    try {
      await service.addRejectedShare('addr', 'duplicate', 5);
      await (service as any).saveCurrent();

      let row = await repository.findOneBy({
        address: 'addr',
        reason: 'duplicate',
        time: timeSlot,
      });

      expect(row).toMatchObject({ count: 11, shares: 104 });

      await service.addRejectedShare('addr', 'duplicate', 3);
      await (service as any).saveCurrent();

      row = await repository.findOneBy({
        address: 'addr',
        reason: 'duplicate',
        time: timeSlot,
      });

      expect(row).toMatchObject({ count: 12, shares: 106 });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
