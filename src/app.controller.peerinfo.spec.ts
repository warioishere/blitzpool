import { Test, TestingModule } from '@nestjs/testing';
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
import { of } from 'rxjs';

import { IPeerInfo } from './models/bitcoin-rpc/IPeerInfo';

describe('AppController info/peers', () => {
  let appController: AppController;
  let bitcoinRpcService: BitcoinRpcService;
  let geoIpService: GeoIpService;
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
        { provide: BitcoinRpcService, useValue: { getPeerInfo: jest.fn() } },
        { provide: AddressSettingsService, useValue: {} },
        { provide: GeoIpService, useValue: { getLocation: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StratumV1JobsService, useValue: { newMiningJob$: of({}), getNextId: jest.fn() } },
      ],
    }).compile();

    appController = module.get<AppController>(AppController);
    bitcoinRpcService = module.get<BitcoinRpcService>(BitcoinRpcService);
    geoIpService = module.get<GeoIpService>(GeoIpService);
  });

  it('should map peer info and resolve locations', async () => {
    const peers: IPeerInfo[] = [
      { addr: '1.2.3.4:8333', addrlocal: '10.0.0.1:8333', subver: '/Satoshi:25.0.0/', inbound: false, bytesrecv: 100, bytessent: 200, network: 'ipv4', pingtime: 0.1 },
      { addr: '[2001:db8::1]:8333', addrlocal: '[::ffff:127.0.0.1]:8333', subver: '/Satoshi:25.0.0/', inbound: true, bytesrecv: 300, bytessent: 400, network: 'ipv6', pingtime: 0.2 },
      { addr: 'abcd.onion:8333', addrlocal: '127.0.0.1:8333', subver: '/Satoshi:25.0.0/', inbound: true, bytesrecv: 500, bytessent: 600, network: 'onion', pingtime: 0.3 },
      { addr: 'efgh.i2p:8333', addrlocal: '127.0.0.1:8334', subver: '/Satoshi:25.0.0/', inbound: true, bytesrecv: 700, bytessent: 800, network: 'i2p', pingtime: 0.4 },
    ];
    (bitcoinRpcService.getPeerInfo as jest.Mock).mockResolvedValue(peers);
    (geoIpService.getLocation as jest.Mock).mockImplementation((ip: string) => {
      if (ip === '1.2.3.4') return { city: 'City', country: 'Country' };
      if (ip === '2001:db8::1') return { city: 'Metro', country: 'World' };
      return null;
    });

    const result = await appController.infoPeers();
    expect(result).toEqual([
      {
        addr: '1.2.3.4:8333',
        version: '/Satoshi:25.0.0/',
        direction: 'outbound',
        location: 'City, Country',
        addrlocal: '10.0.0.1:8333',
        bytesrecv: 100,
        bytessent: 200,
        network: 'ipv4',
        pingtime: 0.1,
      },
      {
        addr: '[2001:db8::1]:8333',
        version: '/Satoshi:25.0.0/',
        direction: 'inbound',
        location: 'Metro, World',
        addrlocal: '[::ffff:127.0.0.1]:8333',
        bytesrecv: 300,
        bytessent: 400,
        network: 'ipv6',
        pingtime: 0.2,
      },
      {
        addr: 'abcd.onion:8333',
        version: '/Satoshi:25.0.0/',
        direction: 'inbound',
        location: 'hidden through tor',
        addrlocal: '127.0.0.1:8333',
        bytesrecv: 500,
        bytessent: 600,
        network: 'onion',
        pingtime: 0.3,
      },
      {
        addr: 'efgh.i2p:8333',
        version: '/Satoshi:25.0.0/',
        direction: 'inbound',
        location: 'hidden through i2p',
        addrlocal: '127.0.0.1:8334',
        bytesrecv: 700,
        bytessent: 800,
        network: 'i2p',
        pingtime: 0.4,
      },
    ]);
  });
});
