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
      ],
    }).compile();

    appController = module.get<AppController>(AppController);
    bitcoinRpcService = module.get<BitcoinRpcService>(BitcoinRpcService);
    geoIpService = module.get<GeoIpService>(GeoIpService);
  });

  it('should map peer info and resolve locations', async () => {
    const peers: IPeerInfo[] = [
      { addr: '1.2.3.4:8333', subver: '/Satoshi:25.0.0/', inbound: false, bytesrecv: 0, bytessent: 0 },
      { addr: '[2001:db8::1]:8333', subver: '/Satoshi:25.0.0/', inbound: true, bytesrecv: 0, bytessent: 0 },
      { addr: 'abcd.onion:8333', subver: '/Satoshi:25.0.0/', inbound: true, bytesrecv: 0, bytessent: 0 },
    ];
    (bitcoinRpcService.getPeerInfo as jest.Mock).mockResolvedValue(peers);
    (geoIpService.getLocation as jest.Mock).mockImplementation((ip: string) => {
      if (ip === '1.2.3.4') return { city: 'City', country: 'Country' };
      if (ip === '2001:db8::1') return { city: 'Metro', country: 'World' };
      return null;
    });

    const result = await appController.infoPeers();
    expect(result).toEqual([
      { addr: '1.2.3.4:8333', version: '/Satoshi:25.0.0/', direction: 'outbound', location: 'City, Country' },
      { addr: '[2001:db8::1]:8333', version: '/Satoshi:25.0.0/', direction: 'inbound', location: 'Metro, World' },
      { addr: 'abcd.onion:8333', version: '/Satoshi:25.0.0/', direction: 'inbound', location: 'hidden through tor' },
    ]);
  });
});
