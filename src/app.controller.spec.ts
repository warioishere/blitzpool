import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { AddressSettingsService } from './ORM/address-settings/address-settings.service';

describe('AppController infoShares', () => {
  let controller: AppController;
  let stats: ClientStatisticsService;
  let blocks: BlocksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        CacheModule.register(),
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: true,
          autoLoadEntities: true,
          logging: false
        }),
        ClientStatisticsModule,
        BlocksModule
      ],
      controllers: [AppController],
      providers: [
        { provide: ClientService, useValue: {} },
        { provide: BitcoinRpcService, useValue: { newBlock$: { subscribe: () => ({}) } } },
        { provide: AddressSettingsService, useValue: {} }
      ]
    }).compile();

    controller = module.get<AppController>(AppController);
    stats = module.get<ClientStatisticsService>(ClientStatisticsService);
    blocks = module.get<BlocksService>(BlocksService);
  });

  it('returns aggregated share totals', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T00:00:00Z'));
    await blocks.save({ height: 1, minerAddress: 'addr1', worker: 'w1', sessionId: 's1', blockData: '00' });

    jest.setSystemTime(new Date('2023-01-01T12:00:00Z'));
    const time = Math.floor(Date.now() / 600000) * 600000;
    await stats.insert({ time, shares: 0, acceptedCount: 3, rejectedCount: 1, address: 'addr1', clientName: 'w1', sessionId: 'AGG' });
    await stats.insert({ time, shares: 0, acceptedCount: 5, rejectedCount: 2, address: 'POOL', clientName: 'POOL', sessionId: 'POOL' });

    const result: any = await controller.infoShares();
    expect(result).toEqual({
      accepted1d: 3,
      rejected1d: 1,
      accepted14d: 3,
      rejected14d: 1,
      accepted30d: 3,
      rejected30d: 1,
      acceptedSinceBlock: 0,
      rejectedSinceBlock: 0
    });
    jest.useRealTimers();
  });
});
