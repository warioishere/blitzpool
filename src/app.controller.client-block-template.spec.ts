jest.mock('node-telegram-bot-api', () => jest.fn());

import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { of } from 'rxjs';
import * as bitcoinjs from 'bitcoinjs-lib';
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
import { StratumV1JobsService, IJobTemplate } from './services/stratum-v1-jobs.service';
import { MetricsService } from './services/metrics.service';
import { MiningModeService } from './services/mining-mode.service';
import { PplnsService } from './services/pplns.service';
import { GroupSoloService } from './services/group-solo.service';
import { PoolModeHashrateService } from './ORM/pool-mode-hashrate/pool-mode-hashrate.service';

describe('AppController /api/client/:address/block-template', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const block = new bitcoinjs.Block();
    block.version = 1;
    block.bits = 1;
    block.timestamp = 1;
    block.nonce = 0;
    block.prevHash = Buffer.alloc(32, 0);
    block.transactions = [new bitcoinjs.Transaction()];
    block.merkleRoot = Buffer.alloc(32, 0);
    block.witnessCommit = Buffer.alloc(32, 0);

    const jobTemplate: IJobTemplate = {
      block,
      merkle_branch: [],
      blockData: {
        id: '1',
        creation: Date.now(),
        coinbasevalue: 50 * 1e8,
        networkDifficulty: 1,
        height: 1,
        clearJobs: false,
      },
    };

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
          useValue: {
            newBlock$: of({ blocks: 123 }),
            getBlockTemplate: jest.fn().mockResolvedValue({ version: 1 }),
          },
        },
        { provide: AddressSettingsService, useValue: {} },
        { provide: GeoIpService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              switch (key) {
                case 'NETWORK':
                  return 'regtest';
                case 'DEV_FEE_ADDRESS':
                  return null;
                case 'DEV_FEE_PERCENT':
                  return '1.5';
                case 'POOL_IDENTIFIER':
                  return 'Test';
                default:
                  return null;
              }
            },
          },
        },
        {
          provide: StratumV1JobsService,
          useValue: {
            newMiningJob$: of(jobTemplate),
            getNextId: () => '1',
          },
        },
        { provide: MetricsService, useValue: {} },
        { provide: MiningModeService, useValue: { getMode: jest.fn().mockResolvedValue({ mode: 'solo' }) } },
        { provide: PplnsService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
        { provide: GroupSoloService, useValue: { isEnabled: () => false, getPayoutDistribution: jest.fn() } },
        { provide: PoolModeHashrateService, useValue: { getChart: jest.fn().mockResolvedValue([]), incrementAccepted: jest.fn() } },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return block template with coinbase tx hex', async () => {
    const address = bitcoinjs.payments.p2wpkh({ hash: Buffer.alloc(20, 0), network: bitcoinjs.networks.regtest }).address;

    const res = await app.inject({ method: 'GET', url: `/api/client/${address}/block-template` });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.coinbaseTxHex).toBeDefined();
    expect(typeof payload.coinbaseTxHex).toBe('string');
    expect(payload.blockHex).toBeDefined();
    expect(payload.blockTemplate).toEqual({ version: 1 });

    const bitcoinRpcService = app.get(BitcoinRpcService);
    expect(bitcoinRpcService.getBlockTemplate).toHaveBeenCalledWith(1);
  });

  it('caches the response keyed on (address, jobTemplateId) — second call skips the build', async () => {
    const address = bitcoinjs.payments.p2wpkh({ hash: Buffer.alloc(20, 0), network: bitcoinjs.networks.regtest }).address;
    const bitcoinRpcService = app.get(BitcoinRpcService) as any;
    const cacheManager = app.get(CACHE_MANAGER) as any;

    // Wire the in-memory cache so the second call hits the cached entry.
    const store = new Map<string, any>();
    cacheManager.get.mockImplementation(async (k: string) => store.get(k));
    cacheManager.set.mockImplementation(async (k: string, v: any) => { store.set(k, v); });

    bitcoinRpcService.getBlockTemplate.mockClear();
    await app.inject({ method: 'GET', url: `/api/client/${address}/block-template` });
    await app.inject({ method: 'GET', url: `/api/client/${address}/block-template` });
    // Heavy work (getblocktemplate) ran once; the second request hit cache.
    expect(bitcoinRpcService.getBlockTemplate).toHaveBeenCalledTimes(1);
    // Cache stored exactly one entry keyed on the template id.
    expect(store.size).toBe(1);
    expect(Array.from(store.keys())[0]).toMatch(/^CLIENT_BLOCK_TEMPLATE_/);
  });
});
