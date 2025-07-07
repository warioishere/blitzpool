import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AddressSettingsModule } from '../../ORM/address-settings/address-settings.module';
import { ClientStatisticsModule } from '../../ORM/client-statistics/client-statistics.module';
import { ClientModule } from '../../ORM/client/client.module';
import { ClientController } from './client.controller';
import { ClientService } from '../../ORM/client/client.service';
import { NotFoundException } from '@nestjs/common';

describe('ClientController', () => {
  let controller: ClientController;
  let clientService: ClientService;

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
        AddressSettingsModule,
        ClientModule,
        ClientStatisticsModule
      ],
      controllers: [ClientController],

    }).compile();

    controller = module.get<ClientController>(ClientController);
    clientService = module.get<ClientService>(ClientService);
    await clientService.deleteAll();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should keep startTime per session within 30 minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T00:00:00Z'));
    const firstSeen = new Date();
    await clientService.insert({
      sessionId: 'sess1',
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker1',
      userAgent: 'ua',
      startTime: firstSeen,
      firstSeen,
      bestDifficulty: 0
    });
    await clientService.insertClients();
    const repo: any = (clientService as any).clientRepository;
    await repo.update({ sessionId: 'sess1' }, { deletedAt: new Date('2023-01-01T00:20:00Z').toLocaleString(), updatedAt: new Date('2023-01-01T00:20:00Z').toLocaleString() });

    jest.setSystemTime(new Date('2023-01-01T00:20:00Z'));
    const prev = await clientService.getFirstSeenIfRecent('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', 'worker1');
    await clientService.insert({
      sessionId: 'sess2',
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker1',
      userAgent: 'ua',
      startTime: new Date(),
      firstSeen: prev || new Date(),
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const worker = await controller.getWorkerInfo('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', 'worker1', 'sess2');
    if (worker instanceof NotFoundException) {
      throw new Error('worker not found');
    }
    expect(new Date(worker.startTime).toISOString()).toBe(new Date('2023-01-01T00:20:00Z').toISOString());
    jest.useRealTimers();
  });

  it('should reset startTime after 30 minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T00:00:00Z'));
    const firstSeen = new Date();
    await clientService.insert({
      sessionId: 'sess1',
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker1',
      userAgent: 'ua',
      startTime: firstSeen,
      firstSeen,
      bestDifficulty: 0
    });
    await clientService.insertClients();
    const repo: any = (clientService as any).clientRepository;
    await repo.update({ sessionId: 'sess1' }, { deletedAt: new Date('2023-01-01T00:00:00Z').toLocaleString(), updatedAt: new Date('2023-01-01T00:00:00Z').toLocaleString() });

    jest.setSystemTime(new Date('2023-01-01T00:40:00Z'));
    const prev = await clientService.getFirstSeenIfRecent('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', 'worker1');
    await clientService.insert({
      sessionId: 'sess2',
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker1',
      userAgent: 'ua',
      startTime: new Date(),
      firstSeen: prev || new Date(),
      bestDifficulty: 0
    });
    await clientService.insertClients();

    const worker = await controller.getWorkerInfo('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', 'worker1', 'sess2');
    if (worker instanceof NotFoundException) {
      throw new Error('worker not found');
    }
    expect(new Date(worker.startTime).toISOString()).toBe(new Date('2023-01-01T00:40:00Z').toISOString());
    jest.useRealTimers();
  });
});
