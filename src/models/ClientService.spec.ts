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
          database: './DB/public-pool.test.sqlite',
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

  it('should keep firstSeen across sessions', async () => {
    const firstSeen = new Date('2023-01-01T00:00:00Z');
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
    await service.delete('s1');

    const prev = await service.getFirstSeen('addr', 'worker');
    await service.insert({
      sessionId: 's2',
      address: 'addr',
      clientName: 'worker',
      userAgent: 'ua',
      startTime: new Date('2023-01-02T00:00:00Z'),
      firstSeen: prev || new Date('2023-01-02T00:00:00Z'),
      bestDifficulty: 0
    });
    await service.insertClients();

    const latest = await service.getBySessionId('addr', 'worker', 's2');
    expect(latest.firstSeen.toISOString()).toBe(firstSeen.toISOString());
  });
});
