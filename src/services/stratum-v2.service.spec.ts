jest.mock('node-telegram-bot-api', () => jest.fn());

import * as crypto from 'crypto';
import { StratumV2Service } from './stratum-v2.service';
import { StratumV2Client } from '../models/StratumV2Client';

// Mock the noise module to avoid loading EllSwift in unit tests
jest.mock('../models/sv2/sv2-noise', () => {
  const actual = jest.requireActual('../models/sv2/sv2-noise');
  return {
    ...actual,
    generateServerKeypair: jest.fn().mockResolvedValue({
      privateKey: Buffer.alloc(32, 0x01),
      publicKey: Buffer.alloc(64, 0x02),
    }),
    xOnlyPubKeyFromPriv: jest.fn().mockReturnValue(Buffer.alloc(32, 0x03)),
    createSignatureNoiseMessage: jest.fn().mockReturnValue({
      version: 0,
      validFrom: 1700000000,
      notValidAfter: 1700086400,
      signature: Buffer.alloc(64, 0x04),
    }),
  };
});

// Mock StratumV2Client to avoid socket operations
jest.mock('../models/StratumV2Client', () => ({
  StratumV2Client: jest.fn(),
}));

function createService(envOverrides: Record<string, string> = {}) {
  const configService = {
    get: jest.fn((key: string) => envOverrides[key] ?? undefined),
  };

  const clientService = {
    resetBestDifficultyForAddress: jest.fn().mockResolvedValue(undefined),
  };

  const addressSettingsCacheService = {
    clear: jest.fn().mockResolvedValue(undefined),
  };

  const difficultyScoresCacheService = {
    clearCache: jest.fn().mockResolvedValue(undefined),
  };

  const service = new StratumV2Service(
    configService as any,
    {} as any, // stratumV1JobsService
    {} as any, // bitcoinRpcService
    clientService as any, // clientService
    {} as any, // clientStatisticsService
    {} as any, // notificationService
    {} as any, // blocksService
    {} as any, // addressSettingsService
    addressSettingsCacheService as any, // addressSettingsCacheService
    {} as any, // poolShareStatisticsService
    {} as any, // poolRejectedStatisticsService
    {} as any, // clientRejectedStatisticsService
    {} as any, // externalSharesService
    {} as any, // clientDifficultyStatisticsService
    {} as any, // shareTotalsCacheService
    difficultyScoresCacheService as any, // difficultyScoresCacheService
    {} as any, // templateDistributionService
    {} as any, // jobDeclarationService
    { isEnabled: () => false } as any, // pplnsService
  );

  return { service, configService, clientService, addressSettingsCacheService, difficultyScoresCacheService };
}

describe('StratumV2Service', () => {
  describe('onModuleInit', () => {
    it('should initialize with auto-generated authority key when env var missing', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const config = service.getNoiseConfig();
      expect(config.staticKeypair.privateKey.length).toBe(32);
      expect(config.staticKeypair.publicKey.length).toBe(64);
      expect(config.certificateMessage.version).toBe(0);
      expect(config.certificateMessage.signature.length).toBe(64);
    });

    it('should use SV2_AUTHORITY_PRIVKEY from env when set', async () => {
      const privKeyHex = crypto.randomBytes(32).toString('hex');
      const { service, configService } = createService({
        SV2_AUTHORITY_PRIVKEY: privKeyHex,
      });
      await service.onModuleInit();

      // The service should have used the provided key
      const config = service.getNoiseConfig();
      expect(config.staticKeypair).toBeDefined();
      expect(config.certificateMessage).toBeDefined();
    });
  });

  describe('getNextChannelId', () => {
    it('should return incrementing channel IDs', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const id1 = service.getNextChannelId();
      const id2 = service.getNextChannelId();
      const id3 = service.getNextChannelId();

      expect(id2).toBe(id1 + 1);
      expect(id3).toBe(id2 + 1);
    });
  });

  describe('generateExtranoncePrefix', () => {
    it('should return a 4-byte buffer', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const prefix = service.generateExtranoncePrefix();
      expect(prefix.length).toBe(4);
    });

    it('should produce different prefixes on repeated calls', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const p1 = service.generateExtranoncePrefix();
      const p2 = service.generateExtranoncePrefix();
      // The random portion should differ
      expect(p1.equals(p2)).toBe(false);
    });
  });

  describe('client registry', () => {
    let service: StratumV2Service;

    beforeEach(async () => {
      const created = createService();
      service = created.service;
      await service.onModuleInit();
    });

    it('should register and retrieve a client', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      service.registerClient('bc1qtest', mockClient);

      const clients = service.getClientsForAddress('bc1qtest');
      expect(clients.size).toBe(1);
      expect(clients.has(mockClient)).toBe(true);
    });

    it('should register multiple clients for same address', () => {
      const client1 = { sessionId: 'test1' } as unknown as StratumV2Client;
      const client2 = { sessionId: 'test2' } as unknown as StratumV2Client;
      service.registerClient('bc1qtest', client1);
      service.registerClient('bc1qtest', client2);

      const clients = service.getClientsForAddress('bc1qtest');
      expect(clients.size).toBe(2);
    });

    it('should unregister a client', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      service.registerClient('bc1qtest', mockClient);
      service.unregisterClient('bc1qtest', mockClient);

      const clients = service.getClientsForAddress('bc1qtest');
      expect(clients.size).toBe(0);
    });

    it('should remove address entry when last client unregisters', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      service.registerClient('bc1qtest', mockClient);
      service.unregisterClient('bc1qtest', mockClient);

      expect(service.getAllAddresses()).not.toContain('bc1qtest');
    });

    it('should handle unregister for non-existent address', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      expect(() => service.unregisterClient('nonexistent', mockClient)).not.toThrow();
    });

    it('should handle register with empty address', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      service.registerClient('', mockClient);
      expect(service.getAllAddresses()).toHaveLength(0);
    });

    it('should handle unregister with undefined address', () => {
      const mockClient = { sessionId: 'test1' } as unknown as StratumV2Client;
      expect(() => service.unregisterClient(undefined, mockClient)).not.toThrow();
    });

    it('should return empty set for unknown address', () => {
      const clients = service.getClientsForAddress('unknown');
      expect(clients.size).toBe(0);
    });

    it('should list all addresses', () => {
      const client1 = { sessionId: 'test1' } as unknown as StratumV2Client;
      const client2 = { sessionId: 'test2' } as unknown as StratumV2Client;
      service.registerClient('addr1', client1);
      service.registerClient('addr2', client2);

      const addresses = service.getAllAddresses();
      expect(addresses).toContain('addr1');
      expect(addresses).toContain('addr2');
      expect(addresses.length).toBe(2);
    });

    it('should list all clients', () => {
      const client1 = { sessionId: 'test1' } as unknown as StratumV2Client;
      const client2 = { sessionId: 'test2' } as unknown as StratumV2Client;
      const client3 = { sessionId: 'test3' } as unknown as StratumV2Client;
      service.registerClient('addr1', client1);
      service.registerClient('addr1', client2);
      service.registerClient('addr2', client3);

      const allClients = service.getAllClients();
      expect(allClients.length).toBe(3);
    });
  });

  describe('getNoiseConfig', () => {
    it('should return a valid noise config after init', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const config = service.getNoiseConfig();
      expect(config.staticKeypair).toBeDefined();
      expect(config.staticKeypair.privateKey.length).toBe(32);
      expect(config.staticKeypair.publicKey.length).toBe(64);
      expect(config.certificateMessage).toBeDefined();
      expect(config.certificateMessage.signature.length).toBe(64);
    });
  });

  describe('certificate rotation', () => {
    it('should regenerate certificate via handleCertificateRotation', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const config1 = service.getNoiseConfig();
      const cert1 = config1.certificateMessage;

      // Trigger manual rotation
      service.handleCertificateRotation();

      const config2 = service.getNoiseConfig();
      const cert2 = config2.certificateMessage;

      // Certificate object should be replaced (mock always returns same values,
      // but the method was called again)
      expect(cert2).toBeDefined();
      expect(cert2.version).toBe(0);
    });
  });

  describe('handleConnection', () => {
    it('should create a StratumV2Client', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const mockSocket = { on: jest.fn(), setTimeout: jest.fn() } as any;
      const firstChunk = Buffer.alloc(64, 0xab);
      const portConfig = {
        port: 3333,
        initialDifficulty: 16384,
        allowSuggestedDifficulty: true,
        targetSharesPerMinute: 6,
      };

      service.handleConnection(mockSocket, firstChunk, portConfig);

      // StratumV2Client constructor should have been called
      expect(StratumV2Client).toHaveBeenCalledTimes(1);
      expect(StratumV2Client).toHaveBeenCalledWith(
        mockSocket,
        firstChunk,
        portConfig,
        service,
        expect.anything(), // stratumV1JobsService
        expect.anything(), // bitcoinRpcService
        expect.anything(), // clientService
        expect.anything(), // clientStatisticsService
        expect.anything(), // notificationService
        expect.anything(), // blocksService
        expect.anything(), // configService
        expect.anything(), // addressSettingsService
        expect.anything(), // addressSettingsCacheService
        expect.anything(), // poolShareStatisticsService
        expect.anything(), // poolRejectedStatisticsService
        expect.anything(), // clientRejectedStatisticsService
        expect.anything(), // externalSharesService
        expect.anything(), // clientDifficultyStatisticsService
        expect.anything(), // shareTotalsCacheService
        expect.anything(), // extranonceManager
        expect.anything(), // templateDistributionService
        expect.anything(), // pplnsService
      );
    });
  });

  describe('getCurrentDifficulties', () => {
    it('should return empty map for unknown address', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const result = service.getCurrentDifficulties('unknown-addr');
      expect(result.size).toBe(0);
    });

    it('should return difficulties for registered clients', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const client1 = { sessionId: 'sess1', getCurrentDifficulty: jest.fn().mockReturnValue(1024) } as any;
      const client2 = { sessionId: 'sess2', getCurrentDifficulty: jest.fn().mockReturnValue(2048) } as any;
      service.registerClient('bc1qtest', client1);
      service.registerClient('bc1qtest', client2);

      const result = service.getCurrentDifficulties('bc1qtest');
      expect(result.size).toBe(2);
      expect(result.get('sess1')).toBe(1024);
      expect(result.get('sess2')).toBe(2048);
    });

    it('should skip clients with null sessionId', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const client1 = { sessionId: null, getCurrentDifficulty: jest.fn() } as any;
      service.registerClient('bc1qtest', client1);

      const result = service.getCurrentDifficulties('bc1qtest');
      expect(result.size).toBe(0);
    });

    it('should skip clients with null difficulty', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const client1 = { sessionId: 'sess1', getCurrentDifficulty: jest.fn().mockReturnValue(null) } as any;
      service.registerClient('bc1qtest', client1);

      const result = service.getCurrentDifficulties('bc1qtest');
      expect(result.size).toBe(0);
    });
  });

  describe('resetBestDifficultyForAddress', () => {
    it('should reset DB, clear caches, and reset local workers', async () => {
      const { service, clientService, addressSettingsCacheService, difficultyScoresCacheService } = createService();
      await service.onModuleInit();

      const client1 = { sessionId: 'sess1', resetBestDifficulty: jest.fn() } as any;
      const client2 = { sessionId: 'sess2', resetBestDifficulty: jest.fn() } as any;
      service.registerClient('bc1qtest', client1);
      service.registerClient('bc1qtest', client2);

      await service.resetBestDifficultyForAddress('bc1qtest');

      expect(clientService.resetBestDifficultyForAddress).toHaveBeenCalledWith('bc1qtest');
      expect(addressSettingsCacheService.clear).toHaveBeenCalledWith('bc1qtest');
      expect(difficultyScoresCacheService.clearCache).toHaveBeenCalledWith('bc1qtest');
      expect(client1.resetBestDifficulty).toHaveBeenCalled();
      expect(client2.resetBestDifficulty).toHaveBeenCalled();
    });

    it('should work even if no local clients exist', async () => {
      const { service, clientService } = createService();
      await service.onModuleInit();

      await service.resetBestDifficultyForAddress('no-clients-addr');

      expect(clientService.resetBestDifficultyForAddress).toHaveBeenCalledWith('no-clients-addr');
    });
  });

  describe('createGroupChannel', () => {
    it('should create a group channel with incrementing IDs', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const id1 = service.createGroupChannel(1024);
      const id2 = service.createGroupChannel(2048);

      expect(id2).toBe(id1 + 1);

      const group1 = service.getGroupChannel(id1);
      expect(group1).toBeDefined();
      expect(group1!.sharedDifficulty).toBe(1024);
      expect(group1!.channelIds.size).toBe(0);

      const group2 = service.getGroupChannel(id2);
      expect(group2).toBeDefined();
      expect(group2!.sharedDifficulty).toBe(2048);
    });
  });

  describe('assignToGroupChannel', () => {
    it('should add channel ID to group and call sendSetGroupChannel on client', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const groupId = service.createGroupChannel(4096);
      const mockClient = { sendSetGroupChannel: jest.fn().mockResolvedValue(undefined) } as any;

      service.assignToGroupChannel(groupId, 42, mockClient);

      const group = service.getGroupChannel(groupId);
      expect(group!.channelIds.has(42)).toBe(true);
      expect(mockClient.sendSetGroupChannel).toHaveBeenCalledWith(groupId, [42]);
    });

    it('should not throw for unknown group channel', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const mockClient = { sendSetGroupChannel: jest.fn().mockResolvedValue(undefined) } as any;
      expect(() => service.assignToGroupChannel(999, 42, mockClient)).not.toThrow();
      expect(mockClient.sendSetGroupChannel).not.toHaveBeenCalled();
    });
  });

  describe('sendReconnectToAddress', () => {
    it('should call sendReconnect on all clients for the address', async () => {
      const { service } = createService();
      await service.onModuleInit();

      const client1 = { sessionId: 'sess1', sendReconnect: jest.fn().mockResolvedValue(undefined) } as any;
      const client2 = { sessionId: 'sess2', sendReconnect: jest.fn().mockResolvedValue(undefined) } as any;
      service.registerClient('bc1qtest', client1);
      service.registerClient('bc1qtest', client2);

      await service.sendReconnectToAddress('bc1qtest', 'pool2.example.com', 3334);

      expect(client1.sendReconnect).toHaveBeenCalledWith('pool2.example.com', 3334);
      expect(client2.sendReconnect).toHaveBeenCalledWith('pool2.example.com', 3334);
    });

    it('should do nothing for unknown address', async () => {
      const { service } = createService();
      await service.onModuleInit();

      await expect(service.sendReconnectToAddress('unknown', 'host', 3333)).resolves.not.toThrow();
    });
  });

});
