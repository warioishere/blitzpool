import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { ClientEntity } from '../ORM/client/client.entity';

describe('ClientService', () => {
  let service: ClientService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: true,
          autoLoadEntities: true,
          cache: true,
          logging: false
        }),
        ClientModule
      ],
    }).compile();
    service = module.get<ClientService>(ClientService);
    await service.deleteAll();
  });

  it('should keep firstSeen for reconnects within 30 minutes and reset afterwards', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T00:00:00Z'));
    const firstSeen = new Date();
    await service.insert({
      sessionId: 's1',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: firstSeen,
      firstSeen,
      bestDifficulty: 0
    });
    await service.insertClients();
    const repo: any = (service as any).clientRepository;
    await repo.update({ sessionId: 's1' }, { deletedAt: new Date('2023-01-01T00:10:00Z').toLocaleString(), updatedAt: new Date('2023-01-01T00:10:00Z').toLocaleString() });

    jest.setSystemTime(new Date('2023-01-01T00:10:00Z'));
    const prev = await service.getFirstSeenIfRecent('addr', 'worker');
    await service.insert({
      sessionId: 's2',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: new Date(),
      firstSeen: prev || new Date(),
      bestDifficulty: 0
    });
    await service.insertClients();
    const latest = await service.getBySessionId('addr', 'worker', 's2');
    expect(latest.firstSeen.toISOString()).toBe(firstSeen.toISOString());

    await repo.update({ sessionId: 's2' }, { deletedAt: new Date('2023-01-01T00:00:00Z').toLocaleString(), updatedAt: new Date('2023-01-01T00:00:00Z').toLocaleString() });
    jest.setSystemTime(new Date('2023-01-01T01:00:00Z'));
    const none = await service.getFirstSeenIfRecent('addr', 'worker');
    await service.insert({
      sessionId: 's3',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: new Date(),
      firstSeen: none || new Date(),
      bestDifficulty: 0
    });
    await service.insertClients();
    const latestReset = await service.getBySessionId('addr', 'worker', 's3');
    expect(latestReset.firstSeen.toISOString()).toBe(new Date('2023-01-01T01:00:00Z').toISOString());
    jest.useRealTimers();
  });
});
