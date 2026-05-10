jest.mock('node-telegram-bot-api', () => jest.fn());

import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { of } from 'rxjs';

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
import { MiningModeService } from './services/mining-mode.service';
import { PplnsService } from './services/pplns.service';
import { GroupSoloService } from './services/group-solo.service';
import { PoolModeHashrateService } from './ORM/pool-mode-hashrate/pool-mode-hashrate.service';

describe('AppController /api/info/core', () => {
  let app: NestFastifyApplication;
  let bitcoinRpcService: BitcoinRpcService;
  let cache: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: CACHE_MANAGER, useValue: cache },
        { provide: ClientService, useValue: {} },
        { provide: ClientStatisticsService, useValue: {} },
        { provide: BlocksService, useValue: {} },
        { provide: PoolShareStatisticsService, useValue: {} },
        { provide: PoolRejectedStatisticsService, useValue: {} },
        { provide: BitcoinRpcService, useValue: { getNetworkInfo: jest.fn(), newBlock$: of({}) } },
        { provide: AddressSettingsService, useValue: {} },
        { provide: GeoIpService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StratumV1JobsService, useValue: { newMiningJob$: of({}), getNextId: jest.fn() } },
        { provide: MetricsService, useValue: {} },
        { provide: MiningModeService, useValue: { getMode: jest.fn().mockResolvedValue({ mode: 'solo' }) } },
        { provide: PplnsService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
        { provide: GroupSoloService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
        { provide: PoolModeHashrateService, useValue: { getChart: jest.fn().mockResolvedValue([]), incrementAccepted: jest.fn() } },
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

  it('should return network info from rpc service', async () => {
    const info = { version: 123, subversion: '/Satoshi:25.0.0/', protocolversion: 70015, connections: 8, warnings: '' };
    (bitcoinRpcService.getNetworkInfo as jest.Mock).mockResolvedValue(info);

    const res = await app.inject({ method: 'GET', url: '/api/info/core' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual(info);
    expect(bitcoinRpcService.getNetworkInfo).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
  });
});
