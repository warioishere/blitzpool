import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigModule } from '@nestjs/config';

import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientStatisticsModule } from '../ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';

describe('Client statistics persistence', () => {
  let clientService: ClientService;
  let statsService: ClientStatisticsService;
  let dataSource: DataSource;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: true,
          autoLoadEntities: true,
          logging: false
        }),
        ClientModule,
        ClientStatisticsModule
      ]
    }).compile();

    clientService = module.get<ClientService>(ClientService);
    statsService = module.get<ClientStatisticsService>(ClientStatisticsService);
    dataSource = module.get<DataSource>(DataSource);
  });

  it('retains statistics after client removal', async () => {
    const now = new Date();
    const client = await clientService.insert({
      sessionId: 's1',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: now,
      firstSeen: now,
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const time = Math.floor(Date.now() / 600000) * 600000;
    await statsService.insert({
      time,
      shares: 0,
      acceptedCount: 8,
      rejectedCount: 0,
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId
    });

    await statsService.insert({
      time,
      shares: 0,
      acceptedCount: 100,
      rejectedCount: 50,
      address: 'POOL',
      clientName: 'POOL',
      sessionId: 'POOL'
    });

    await statsService.insert({
      time,
      shares: 0,
      acceptedCount: 4,
      rejectedCount: 2,
      address: client.address,
      clientName: client.clientName,
      sessionId: 'AGG'
    });

    await clientService.delete(client.sessionId);

    await dataSource.getRepository(ClientEntity).update(
      { sessionId: client.sessionId },
      { deletedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }
    );
    await clientService.deleteOldClients();

    const repo = dataSource.getRepository(ClientStatisticsEntity);
    expect(await repo.count()).toBe(3);
    const totals = await statsService.getTotalsLastDays(1);
    expect(totals).toEqual([{ address: 'addr', accepted: 12, rejected: 2 }]);
  });

  it('resets stats using seconds timestamp', async () => {
    process.env.SHARE_STATS_RESET_AFTER = '1700000000';

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: true,
          autoLoadEntities: true,
          logging: false
        }),
        ClientStatisticsModule
      ]
    }).compile();

    const service = module.get<ClientStatisticsService>(ClientStatisticsService);

    const before = new Date('2023-11-14T21:13:20Z').getTime();
    const after = new Date('2023-11-14T23:13:20Z').getTime();

    await service.insert({
      time: before,
      shares: 0,
      acceptedCount: 1,
      rejectedCount: 0,
      address: 'addr',
      clientName: 'worker',
      sessionId: 's1'
    });

    await service.insert({
      time: after,
      shares: 0,
      acceptedCount: 2,
      rejectedCount: 1,
      address: 'addr',
      clientName: 'worker',
      sessionId: 's2'
    });

    jest.useFakeTimers().setSystemTime(new Date('2023-11-15T02:13:20Z'));
    const totals = await service.getTotalsLastDays(1);
    jest.useRealTimers();

    expect(totals).toEqual([{ address: 'addr', accepted: 2, rejected: 1 }]);

    delete process.env.SHARE_STATS_RESET_AFTER;
  });

  it('flushes statistics on client destroy', async () => {
    const now = new Date();
    const client = await clientService.insert({
      sessionId: 's2',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: now,
      firstSeen: now,
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const socket = {
      destroyed: false,
      writableEnded: false,
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    } as unknown as import('net').Socket;

    const empty: any = {};
    const configService = { get: (k: string) => (k === 'NETWORK' ? 'testnet' : null) } as any;
    const stratumClient = new (require('./StratumV1Client').StratumV1Client)(
      socket,
      empty,
      empty,
      clientService,
      statsService,
      empty,
      empty,
      configService,
      empty,
      empty
    );

    (stratumClient as any).entity = client;
    (stratumClient as any).statistics = new (require('./StratumV1ClientStatistics').StratumV1ClientStatistics)(statsService);

    await (stratumClient as any).statistics.addRejectedShare(client, 1);
    await (stratumClient as any).statistics.addRejectedShare(client, 1);

    await stratumClient.destroy();

    const repo = dataSource.getRepository(ClientStatisticsEntity);
    const rows = await repo.find();
    expect(rows.length).toBe(1);
  expect(rows[0].rejectedCount).toBe(2);
  });

  it('persists rejected shares after sixty seconds', async () => {
    jest.useFakeTimers();

    const now = new Date('2023-11-14T00:00:00Z');
    jest.setSystemTime(now);

    const client = await clientService.insert({
      sessionId: 's3',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: now,
      firstSeen: now,
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const stats = new (require('./StratumV1ClientStatistics').StratumV1ClientStatistics)(statsService);

    await stats.addRejectedShare(client, 1);
    let repo = dataSource.getRepository(ClientStatisticsEntity);
    expect((await repo.find())[0].rejectedCount).toBe(1);

    jest.setSystemTime(new Date(now.getTime() + 30_000));
    await stats.addRejectedShare(client, 1);
    expect((await repo.find())[0].rejectedCount).toBe(1);

    jest.setSystemTime(new Date(now.getTime() + 61_000));
    await stats.addRejectedShare(client, 1);
    const rows = await repo.find();
    expect(rows.length).toBe(1);
    expect(rows[0].rejectedCount).toBe(3);

    jest.useRealTimers();
  });

  it('saves counts when time slot changes', async () => {
    jest.useFakeTimers();

    const start = new Date('2023-11-14T00:00:00Z');
    jest.setSystemTime(start);

    const client = await clientService.insert({
      sessionId: 's4',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: start,
      firstSeen: start,
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const stats = new (require('./StratumV1ClientStatistics').StratumV1ClientStatistics)(statsService);

    await stats.addRejectedShare(client, 1);
    jest.setSystemTime(new Date(start.getTime() + 5 * 60_000));
    await stats.addRejectedShare(client, 1);
    jest.setSystemTime(new Date(start.getTime() + 10 * 60_000 + 1_000));
    await stats.addRejectedShare(client, 1);

    const repo = dataSource.getRepository(ClientStatisticsEntity);
    const rows = await repo.find({ order: { time: 'ASC' } });
    expect(rows.length).toBe(2);
    expect(rows[0].rejectedCount).toBe(2);
    expect(rows[1].rejectedCount).toBe(1);

    jest.useRealTimers();
  });
});
