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

  it('retains shares added while a flush is executing', async () => {
    const tenMinutes = 1000 * 60 * 10;
    const baseTimestamp = 1800000000000;
    const timeSlot = Math.floor(baseTimestamp / tenMinutes) * tenMinutes;

    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(baseTimestamp + 30_000);

    const rows = new Map<
      number,
      { accepted: number; rejected: number }
    >();

    let resolveExecute: () => void = () => {};
    const executeBlocker = new Promise<void>((resolve) => {
      resolveExecute = resolve;
    });
    let notifyStarted: () => void = () => {};
    const executeStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let firstExecute = true;

    const repository = {
      createQueryBuilder: () => {
        const builder: any = {
          payload: {
            time: timeSlot,
            accepted: 0,
            rejected: 0,
          },
          insert() {
            return this;
          },
          into() {
            return this;
          },
          values(value: Partial<PoolShareStatisticsEntity>) {
            this.payload = value;
            return this;
          },
          onConflict() {
            return this;
          },
          setParameters() {
            return this;
          },
          async execute() {
            if (firstExecute) {
              firstExecute = false;
              notifyStarted();
              await executeBlocker;
            }
            const { time, accepted = 0, rejected = 0 } = this.payload;
            const current = rows.get(time) ?? { accepted: 0, rejected: 0 };
            rows.set(time, {
              accepted: current.accepted + accepted,
              rejected: current.rejected + rejected,
            });
          },
        };
        return builder;
      },
      findOneBy({ time }: { time: number }) {
        const row = rows.get(time);
        return row ? { time, ...row } : null;
      },
    };

    const service = new PoolShareStatisticsService(repository as any);

    try {
      await service.addAcceptedShare(2);
      await service.addRejectedShare(1);

      const flushPromise = (service as any).flush();

      await executeStarted;

      await service.addAcceptedShare(5);
      await service.addRejectedShare(4);

      resolveExecute();

      await flushPromise;

      let row = await repository.findOneBy({ time: timeSlot });
      expect(row).toMatchObject({ accepted: 2, rejected: 1 });

      await (service as any).flush();

      row = await repository.findOneBy({ time: timeSlot });
      expect(row).toMatchObject({ accepted: 7, rejected: 5 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('requeues the snapshot if persistence fails', async () => {
    const tenMinutes = 1000 * 60 * 10;
    const baseTimestamp = 1900000000000;
    const timeSlot = Math.floor(baseTimestamp / tenMinutes) * tenMinutes;

    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(baseTimestamp + 15_000);

    const rows = new Map<
      number,
      { accepted: number; rejected: number }
    >();

    let shouldFail = true;

    const repository = {
      createQueryBuilder: () => {
        const builder: any = {
          payload: {
            time: timeSlot,
            accepted: 0,
            rejected: 0,
          },
          insert() {
            return this;
          },
          into() {
            return this;
          },
          values(value: Partial<PoolShareStatisticsEntity>) {
            this.payload = value;
            return this;
          },
          onConflict() {
            return this;
          },
          setParameters() {
            return this;
          },
          async execute() {
            if (shouldFail) {
              shouldFail = false;
              throw new Error('boom');
            }
            const { time, accepted = 0, rejected = 0 } = this.payload;
            const current = rows.get(time) ?? { accepted: 0, rejected: 0 };
            rows.set(time, {
              accepted: current.accepted + accepted,
              rejected: current.rejected + rejected,
            });
          },
        };
        return builder;
      },
      findOneBy({ time }: { time: number }) {
        const row = rows.get(time);
        return row ? { time, ...row } : null;
      },
    };

    const service = new PoolShareStatisticsService(repository as any);

    try {
      await service.addAcceptedShare(6);
      await service.addRejectedShare(2);

      await expect((service as any).flush()).rejects.toThrow('boom');

      expect(rows.size).toBe(0);

      await (service as any).flush();

      const row = await repository.findOneBy({ time: timeSlot });
      expect(row).toMatchObject({ accepted: 6, rejected: 2 });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
