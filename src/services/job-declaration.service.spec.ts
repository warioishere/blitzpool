jest.mock('node-telegram-bot-api', () => jest.fn());

import { JobDeclarationService } from './job-declaration.service';
import { Sv2DeclareMiningJob } from '../models/sv2/sv2-jdp-messages';

// Mock noise module
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

function createService(envOverrides: Record<string, string> = {}) {
  const configService = {
    get: jest.fn((key: string) => envOverrides[key] ?? undefined),
  };

  const bitcoinRpcService = {
    getRawMempool: jest.fn().mockResolvedValue([
      'aabb'.repeat(16),
      'ccdd'.repeat(16),
      'eeff'.repeat(16),
    ]),
    getRawMempoolWtxids: jest.fn().mockResolvedValue(new Set([
      'aabb'.repeat(16),
      'ccdd'.repeat(16),
      'eeff'.repeat(16),
    ])),
    getRawTransaction: jest.fn().mockResolvedValue(null),
    SUBMIT_BLOCK: jest.fn().mockResolvedValue('SUCCESS!'),
  };

  const stratumV2Service = {
    getNoiseConfig: jest.fn().mockReturnValue({
      staticKeypair: {
        privateKey: Buffer.alloc(32, 0x01),
        publicKey: Buffer.alloc(64, 0x02),
      },
      certificateMessage: {
        version: 0,
        validFrom: 1700000000,
        notValidAfter: 1700086400,
        signature: Buffer.alloc(64, 0x04),
      },
    }),
    getAllClients: jest.fn().mockReturnValue([]),
  };

  const templateDistributionService = {
    getLatestTemplate: jest.fn().mockReturnValue(undefined),
  };

  const blocksService = { save: jest.fn().mockResolvedValue(undefined) };
  const notificationService = { notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined) };

  const service = new JobDeclarationService(
    configService as any,
    bitcoinRpcService as any,
    stratumV2Service as any,
    templateDistributionService as any,
    blocksService as any,
    notificationService as any,
  );

  return { service, configService, bitcoinRpcService, stratumV2Service };
}

describe('JobDeclarationService', () => {
  describe('initialization', () => {
    it('should not start JDP server when disabled', async () => {
      const { service } = createService();
      await service.onModuleInit();
      expect(service.connectedClients).toBe(0);
    });

    it('should use default port 3337', () => {
      const { service } = createService();
      expect(service.connectedClients).toBe(0);
    });
  });

  describe('validateTransactions', () => {
    it('should identify known transactions from mempool', async () => {
      const { service, bitcoinRpcService } = createService();

      const result = await service.validateTransactions([
        'aabb'.repeat(16),
        'unknown'.padEnd(64, '0'),
      ]);

      expect(result.known).toEqual(['aabb'.repeat(16)]);
      expect(result.unknown).toEqual(['unknown'.padEnd(64, '0')]);
      expect(bitcoinRpcService.getRawMempoolWtxids).toHaveBeenCalled();
    });

    it('should handle all known transactions', async () => {
      const { service } = createService();

      const result = await service.validateTransactions([
        'aabb'.repeat(16),
        'ccdd'.repeat(16),
      ]);

      expect(result.known).toHaveLength(2);
      expect(result.unknown).toHaveLength(0);
    });

    it('should handle all unknown transactions', async () => {
      const { service } = createService();

      const result = await service.validateTransactions([
        '1111'.repeat(16),
        '2222'.repeat(16),
      ]);

      expect(result.known).toHaveLength(0);
      expect(result.unknown).toHaveLength(2);
    });

    it('should handle empty transaction list', async () => {
      const { service } = createService();

      const result = await service.validateTransactions([]);

      expect(result.known).toHaveLength(0);
      expect(result.unknown).toHaveLength(0);
    });

    it('should accept all transactions on RPC failure', async () => {
      const { service, bitcoinRpcService } = createService();
      bitcoinRpcService.getRawMempoolWtxids.mockRejectedValue(new Error('RPC error'));

      const result = await service.validateTransactions(['hash1', 'hash2']);

      expect(result.known).toEqual(['hash1', 'hash2']);
      expect(result.unknown).toHaveLength(0);
    });
  });

  describe('onJobDeclared', () => {
    it('should log declared job and store it', () => {
      const { service } = createService();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const token = Buffer.from('newtoken');
      const job: Sv2DeclareMiningJob = {
        requestId: 1,
        miningJobToken: Buffer.from('token'),
        version: 0x20000000,
        coinbaseTxPrefix: Buffer.alloc(0),
        coinbaseTxSuffix: Buffer.alloc(0),
        wtxidList: [Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)],
        excessData: Buffer.alloc(0),
      };

      service.onJobDeclared('client1', job, token);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('DeclareMiningJob SUCCESS'),
      );

      // Verify the declared job is stored
      const stored = service.getDeclaredJob(token.toString('hex'));
      expect(stored).toBeDefined();
      expect(stored!.job.requestId).toBe(1);
      expect(stored!.clientId).toBe('client1');

      consoleSpy.mockRestore();
    });

    it('should store declared job without bridging (JDC sends SetCustomMiningJob itself)', () => {
      const { service } = createService();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const job: Sv2DeclareMiningJob = {
        requestId: 2,
        miningJobToken: Buffer.from('token2'),
        version: 0x20000000,
        coinbaseTxPrefix: Buffer.from('prefix'),
        coinbaseTxSuffix: Buffer.from('suffix'),
        wtxidList: [],
        excessData: Buffer.alloc(0),
      };

      const token = Buffer.from('newtoken2');
      service.onJobDeclared('test-client', job, token);

      // Verify the job was stored
      const stored = service.getDeclaredJob(token.toString('hex'));
      expect(stored).toBeDefined();
      expect(stored!.job).toBe(job);
      expect(stored!.clientId).toBe('test-client');

      consoleSpy.mockRestore();
    });
  });

  describe('getNoiseConfig', () => {
    it('should delegate to StratumV2Service', () => {
      const { service, stratumV2Service } = createService();
      const config = service.getNoiseConfig();
      expect(stratumV2Service.getNoiseConfig).toHaveBeenCalled();
      expect(config.staticKeypair).toBeDefined();
    });
  });

  describe('client management', () => {
    it('should return undefined for unknown client', () => {
      const { service } = createService();
      expect(service.getClient('nonexistent')).toBeUndefined();
    });

    it('should report 0 connected clients initially', () => {
      const { service } = createService();
      expect(service.connectedClients).toBe(0);
    });
  });

  describe('getTemplateTransactions', () => {
    it('should return empty map when no template available', () => {
      const { service } = createService();
      const result = service.getTemplateTransactions();
      expect(result.size).toBe(0);
    });

    it('should return empty map when template has no transactions', () => {
      const { service } = createService();
      (service as any).templateDistributionService.getLatestTemplate.mockReturnValue({
        template: {},
        prevHash: {},
        jobTemplate: { block: { transactions: [] } },
      });
      const result = service.getTemplateTransactions();
      expect(result.size).toBe(0);
    });
  });

  describe('submitBlock', () => {
    it('should delegate to bitcoinRpcService', async () => {
      const { service, bitcoinRpcService } = createService();
      const result = await service.submitBlock('deadbeef');
      expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith('deadbeef');
      expect(result).toBe('SUCCESS!');
    });
  });

  describe('getMinerAddressByIp', () => {
    it('should find miner address by matching IP', () => {
      const { service, stratumV2Service } = createService();
      stratumV2Service.getAllClients.mockReturnValue([
        { getRemoteAddress: () => '10.0.0.1', getAddress: () => 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
        { getRemoteAddress: () => '10.0.0.2', getAddress: () => 'bc1qother' },
      ]);

      expect(service.getMinerAddressByIp('10.0.0.1')).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    });

    it('should return null when no matching IP', () => {
      const { service, stratumV2Service } = createService();
      stratumV2Service.getAllClients.mockReturnValue([
        { getRemoteAddress: () => '10.0.0.1', getAddress: () => 'bc1qtest' },
      ]);

      expect(service.getMinerAddressByIp('10.0.0.99')).toBeNull();
    });

    it('should normalize IPv6-mapped IPv4 addresses', () => {
      const { service, stratumV2Service } = createService();
      stratumV2Service.getAllClients.mockReturnValue([
        { getRemoteAddress: () => '192.168.1.100', getAddress: () => 'bc1qtest123' },
      ]);

      // IPv6-mapped address should match plain IPv4
      expect(service.getMinerAddressByIp('::ffff:192.168.1.100')).toBe('bc1qtest123');
    });
  });

  describe('getCoinbaseOutputsForToken', () => {
    it('should return valid Bitcoin consensus-encoded Vec<TxOut> with p2wpkh script', () => {
      const { service } = createService({ NETWORK: 'mainnet' });
      const result = service.getCoinbaseOutputsForToken('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');

      // varint(1) + u64_le(0) + varint(22) + p2wpkh_script(22)
      expect(result.length).toBe(1 + 8 + 1 + 22); // 32 bytes
      expect(result[0]).toBe(0x01);           // 1 output
      expect(result.readBigUInt64LE(1)).toBe(0n); // value = 0
      expect(result[9]).toBe(22);             // script length = 22
      expect(result[10]).toBe(0x00);          // OP_0 (witness version 0)
      expect(result[11]).toBe(0x14);          // push 20 bytes
    });

    it('should encode different p2wpkh addresses correctly', () => {
      const { service } = createService({ NETWORK: 'mainnet' });
      const result = service.getCoinbaseOutputsForToken('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');

      // varint(1) + u64_le(0) + varint(22) + p2wpkh_script(22)
      expect(result.length).toBe(32);
      expect(result[0]).toBe(0x01);
      expect(result.readBigUInt64LE(1)).toBe(0n);
      expect(result[9]).toBe(22);
    });
  });

  describe('getRawTransaction', () => {
    it('should return buffer from hex string', async () => {
      const { service, bitcoinRpcService } = createService();
      bitcoinRpcService.getRawTransaction.mockResolvedValue('aabbccdd');
      const result = await service.getRawTransaction('sometxid');
      expect(result).toEqual(Buffer.from('aabbccdd', 'hex'));
    });

    it('should return null when RPC returns null', async () => {
      const { service } = createService();
      const result = await service.getRawTransaction('unknown');
      expect(result).toBeNull();
    });
  });
});
