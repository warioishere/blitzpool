import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientStatisticsService } from './client-statistics.service';
import { ClientService } from '../client/client.service';

describe('ClientStatisticsService.getLastShareTime', () => {
  let service: ClientStatisticsService;
  let repo: Repository<ClientStatisticsEntity>;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          dropSchema: true,
          synchronize: true,
          entities: [ClientStatisticsEntity],
        }),
        TypeOrmModule.forFeature([ClientStatisticsEntity]),
      ],
      providers: [
        ClientStatisticsService,
        { provide: ClientService, useValue: { getRecentHashRate: jest.fn() } },
      ],
    }).compile();

    service = module.get(ClientStatisticsService);
    repo = module.get<Repository<ClientStatisticsEntity>>(getRepositoryToken(ClientStatisticsEntity));
  });

  afterAll(async () => {
    await module.close();
  });

  it('returns timestamp of latest updated record', async () => {
    await repo.insert({
      address: 'addr',
      clientName: 'worker1',
      sessionId: 's1',
      time: 1,
      shares: 1,
      acceptedCount: 0,
      createdAt: new Date('2023-01-01T00:00:00Z'),
      updatedAt: new Date('2023-01-01T00:00:00Z'),
    });
    await repo.insert({
      address: 'addr',
      clientName: 'worker1',
      sessionId: 's1',
      time: 2,
      shares: 1,
      acceptedCount: 0,
      createdAt: new Date('2023-01-02T00:00:00Z'),
      updatedAt: new Date('2023-01-02T00:00:00Z'),
    });
    const ts = await service.getLastShareTime('addr', 'worker1');
    expect(ts).toBe(new Date('2023-01-02T00:00:00Z').getTime());
  });

  it('computes hashrate for short windows from DB', async () => {
    const now = Date.now();
    await repo.insert({
      address: 'addr',
      clientName: 'worker1',
      sessionId: 's1',
      time: now - 30_000,
      shares: 1,
      acceptedCount: 0,
      createdAt: new Date(now - 30_000),
      updatedAt: new Date(now - 30_000),
    });
    const rate = await service.getHashRate({ address: 'addr', since: now - 60_000 });
    expect(rate).toBeGreaterThan(0);
  });
});
