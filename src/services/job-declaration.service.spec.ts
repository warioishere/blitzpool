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

  const miningModeService = {
    getMode: jest.fn().mockResolvedValue({ mode: 'solo' }),
  };
  const pplnsService = {
    isEnabled: jest.fn().mockReturnValue(false),
    getPayoutDistribution: jest.fn().mockResolvedValue([]),
  };
  const groupSoloService = {
    isEnabled: jest.fn().mockReturnValue(false),
    getPayoutDistribution: jest.fn().mockResolvedValue([]),
  };

  const service = new JobDeclarationService(
    configService as any,
    bitcoinRpcService as any,
    stratumV2Service as any,
    templateDistributionService as any,
    blocksService as any,
    notificationService as any,
    miningModeService as any,
    pplnsService as any,
    groupSoloService as any,
  );

  return {
    service,
    configService,
    bitcoinRpcService,
    stratumV2Service,
    templateDistributionService,
    miningModeService,
    pplnsService,
    groupSoloService,
  };
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

  describe('encodeCoinbaseOutputs', () => {
    it('should encode a single p2wpkh address as a 1-output Vec<TxOut>', () => {
      const { service } = createService({ NETWORK: 'mainnet' });
      const result = service.encodeCoinbaseOutputs(['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']);

      // varint(1) + u64_le(0) + varint(22) + p2wpkh_script(22) = 32 bytes
      expect(result.length).toBe(32);
      expect(result[0]).toBe(0x01);
      expect(result.readBigUInt64LE(1)).toBe(0n);
      expect(result[9]).toBe(22);
      expect(result[10]).toBe(0x00);
      expect(result[11]).toBe(0x14);
    });

    it('should encode a multi-output (3-address) Vec<TxOut>', () => {
      const { service } = createService({ NETWORK: 'mainnet' });
      // All three are valid P2WPKH (BIP173) → 22-byte scriptPubKey each.
      const result = service.encodeCoinbaseOutputs([
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      ]);

      // varint(3) + 3 × (u64_le + varint(22) + p2wpkh_script(22)) = 1 + 3*31 = 94
      expect(result.length).toBe(94);
      expect(result[0]).toBe(0x03);
    });

    it('should encode empty address list as zero-count buffer', () => {
      const { service } = createService({ NETWORK: 'mainnet' });
      const result = service.encodeCoinbaseOutputs([]);
      expect(result.length).toBe(1);
      expect(result[0]).toBe(0x00);
    });
  });

  describe('resolveCoinbasePayout', () => {
    const SV2_EXT_0x0003 = 0x0003;

    it('should return single-output (no weights) when ext 0x0003 not negotiated', async () => {
      const { service } = createService();
      const result = await service.resolveCoinbasePayout(
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        new Set(),
      );
      expect(result.addresses).toEqual(['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']);
      expect(result.weights).toBeNull();
    });

    it('should ignore PPLNS distribution when ext 0x0003 not negotiated (spec-purity)', async () => {
      const { service, pplnsService, miningModeService } = createService();
      miningModeService.getMode.mockResolvedValue({ mode: 'pplns' });
      pplnsService.isEnabled.mockReturnValue(true);
      pplnsService.getPayoutDistribution.mockResolvedValue([
        { address: 'bc1qfee', percent: 0.01, sats: 3_125_000 },
        { address: 'bc1qminer1', percent: 0.99, sats: 309_375_000 },
      ]);

      const result = await service.resolveCoinbasePayout(
        'bc1qminer1',
        new Set(), // no extensions negotiated
      );

      // Spec compliance: base JDP MUST stay single-output.
      expect(result.addresses).toEqual(['bc1qminer1']);
      expect(result.weights).toBeNull();
      expect(pplnsService.getPayoutDistribution).not.toHaveBeenCalled();
    });

    it('should emit multi-output + weights for PPLNS when ext 0x0003 negotiated', async () => {
      const { service, pplnsService, miningModeService } = createService();
      miningModeService.getMode.mockResolvedValue({ mode: 'pplns' });
      pplnsService.isEnabled.mockReturnValue(true);
      pplnsService.getPayoutDistribution.mockResolvedValue([
        { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', percent: 0.01, sats: 3_125_000 },
        { address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', percent: 0.99, sats: 309_375_000 },
      ]);

      const result = await service.resolveCoinbasePayout(
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        new Set([SV2_EXT_0x0003]),
      );

      expect(result.addresses).toEqual([
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      ]);
      expect(result.weights).toEqual([3_125_000, 309_375_000]);
    });

    it('should emit multi-output + weights for Group-Solo with finder bonus', async () => {
      const { service, groupSoloService, miningModeService } = createService();
      miningModeService.getMode.mockResolvedValue({ mode: 'group-solo', groupId: 'g42' });
      groupSoloService.isEnabled.mockReturnValue(true);
      groupSoloService.getPayoutDistribution.mockResolvedValue([
        { address: 'bc1qfee',     percent: 0.01, sats: 3_125_000 },
        { address: 'bc1qfinder',  percent: 0.40, sats: 125_000_000 }, // higher because finder bonus
        { address: 'bc1qmember2', percent: 0.59, sats: 184_375_000 },
      ]);

      const result = await service.resolveCoinbasePayout(
        'bc1qfinder',
        new Set([SV2_EXT_0x0003]),
      );

      expect(result.addresses).toEqual(['bc1qfee', 'bc1qfinder', 'bc1qmember2']);
      expect(result.weights).toEqual([3_125_000, 125_000_000, 184_375_000]);
      // Finder address MUST be passed through so finder-bonus output is included.
      expect(groupSoloService.getPayoutDistribution).toHaveBeenCalledWith(
        'g42',
        expect.any(Number),
        'bc1qfinder',
      );
    });

    it('should fall back to solo when PPLNS distribution fetch throws', async () => {
      const { service, pplnsService, miningModeService } = createService();
      miningModeService.getMode.mockResolvedValue({ mode: 'pplns' });
      pplnsService.isEnabled.mockReturnValue(true);
      pplnsService.getPayoutDistribution.mockRejectedValue(new Error('redis down'));

      const result = await service.resolveCoinbasePayout(
        'bc1qminer',
        new Set([SV2_EXT_0x0003]),
      );

      expect(result.addresses).toEqual(['bc1qminer']);
      expect(result.weights).toBeNull();
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
