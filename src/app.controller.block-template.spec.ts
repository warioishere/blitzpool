jest.mock('node-telegram-bot-api', () => jest.fn());

import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { of } from 'rxjs';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

import { AppController } from './app.controller';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { GeoIpService } from './services/geoip.service';
import { ClientService } from './ORM/client/client.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { PoolShareStatisticsService } from './ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from './ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { ConfigService } from '@nestjs/config';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { MetricsService } from './services/metrics.service';
import { LiveHashrateService } from './services/live-hashrate.service';
import { MiningModeService } from './services/mining-mode.service';
import { PplnsService } from './services/pplns.service';
import { GroupSoloService } from './services/group-solo.service';

describe('AppController /api/info/block-template', () => {
  let app: NestFastifyApplication;
  let bitcoinRpcService: BitcoinRpcService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: ClientService, useValue: {} },
        { provide: ClientStatisticsService, useValue: {} },
        { provide: BlocksService, useValue: {} },
        { provide: PoolShareStatisticsService, useValue: {} },
        { provide: PoolRejectedStatisticsService, useValue: {} },
        {
          provide: BitcoinRpcService,
          useValue: { newBlock$: of({ blocks: 123 }), getBlockTemplate: jest.fn() },
        },
        { provide: AddressSettingsService, useValue: {} },
        { provide: GeoIpService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StratumV1JobsService, useValue: { newMiningJob$: of({}), getNextId: jest.fn() } },
        { provide: MetricsService, useValue: {} },
        { provide: LiveHashrateService, useValue: {} },
        { provide: MiningModeService, useValue: { getMode: jest.fn().mockResolvedValue({ mode: 'solo' }) } },
        { provide: PplnsService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
        { provide: GroupSoloService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
      ],
    }).compile();

    bitcoinRpcService = module.get<BitcoinRpcService>(BitcoinRpcService);
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return the current block template', async () => {
    const template = { test: 'template' };
    (bitcoinRpcService.getBlockTemplate as jest.Mock).mockResolvedValue(template);

    const res = await app.inject({ method: 'GET', url: '/api/info/block-template' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(template);
    expect(bitcoinRpcService.getBlockTemplate).toHaveBeenCalledWith(123);
  });
});
