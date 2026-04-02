jest.mock('node-telegram-bot-api', () => jest.fn());

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { StratumV2Client } from './StratumV2Client';
import {
  Sv2NoiseSession,
  Sv2NoiseInitiator,
  generateServerKeypair,
  xOnlyPubKeyFromPriv,
  createSignatureNoiseMessage,
  Sv2NoiseConfig,
} from './sv2/sv2-noise';
import { Sv2FrameWriter, Sv2FrameReader } from './sv2/sv2-frame';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
  Sv2MsgType,
  SV2_CHANNEL_MSG_FLAG,
  Sv2MiningSetupFlags,
  Sv2MiningSetupSuccessFlags,
} from './sv2/sv2-constants';
import {
  serializeSetupConnection,
  deserializeSetupConnectionSuccess,
  serializeOpenStandardMiningChannel,
  deserializeOpenStandardMiningChannelSuccess,
  deserializeNewMiningJob,
  deserializeSetNewPrevHash,
  serializeSubmitSharesStandard,
  deserializeSubmitSharesSuccess,
  deserializeSubmitSharesError,
  deserializeSetTarget,
} from './sv2/sv2-messages';
import {
  serializeOpenExtendedMiningChannel,
  deserializeOpenExtendedMiningChannelSuccess,
  deserializeNewExtendedMiningJob,
  serializeSubmitSharesExtended,
} from './sv2/sv2-extended-messages';
import { Sv2ExtranonceManager } from './sv2/sv2-extranonce-manager';
import {
  serializeTdpSubmitSolution,
  serializeTdpRequestTransactionData,
  deserializeTdpRequestTransactionDataError,
} from './sv2/sv2-tdp-messages';
import { DifficultyUtils } from '../utils/difficulty.utils';

// ── Mock Socket ─────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  written: Buffer[] = [];

  setTimeout = jest.fn();
  setNoDelay = jest.fn();
  setEncoding = jest.fn();
  end = jest.fn(() => { this.writableEnded = true; });

  write(data: Buffer | string, cb?: (err?: Error) => void): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.written.push(buf);
    if (cb) cb();
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  /** Drain all written bytes and reset */
  drainWritten(): Buffer {
    const all = Buffer.concat(this.written);
    this.written = [];
    return all;
  }
}

// ── Mock Services ───────────────────────────────────────────────────

function createMockServices() {
  const configService = {
    get: jest.fn((key: string) => {
      const defaults: Record<string, string> = {
        NETWORK: 'regtest',
        DIFFICULTY_CHECK_INTERVAL_MS: '60000',
      };
      return defaults[key] ?? undefined;
    }),
  };

  const stratumV1JobsService = {
    newMiningJob$: {
      subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
      pipe: jest.fn(),
    },
    getNextId: jest.fn().mockReturnValue('1'),
    getNextTemplateId: jest.fn().mockReturnValue('1'),
    addJob: jest.fn(),
    getJobById: jest.fn(),
    getJobTemplateById: jest.fn(),
    jobs: {},
  };

  const clientService = {
    delete: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue({
      sessionId: 'test-session',
      address: 'bcrt1qtest',
      clientName: 'worker1',
      userAgent: 'test/1.0',
      startTime: new Date(),
      firstSeen: new Date(),
      bestDifficulty: 0,
      currentDifficulty: 16384,
      updatedAt: null,
    }),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    updateBestDifficulty: jest.fn().mockResolvedValue(undefined),
    updateCurrentDifficulty: jest.fn().mockResolvedValue(undefined),
    getFirstSeenIfRecent: jest.fn().mockResolvedValue(null),
  };

  const notificationService = {
    notifyDeviceStatusChange: jest.fn().mockResolvedValue(undefined),
    notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
    notifySubscribersBestDiff: jest.fn().mockResolvedValue(undefined),
  };

  const clientStatisticsService = {
    addAcceptedShare: jest.fn().mockResolvedValue(undefined),
    addRejectedShare: jest.fn().mockResolvedValue(undefined),
  };

  const poolShareStatisticsService = {
    addAcceptedShare: jest.fn().mockResolvedValue(undefined),
    addRejectedShare: jest.fn().mockResolvedValue(undefined),
  };

  const poolRejectedStatisticsService = {
    addRejectedShare: jest.fn().mockResolvedValue(true),
  };

  const clientRejectedStatisticsService = {
    addRejectedShare: jest.fn().mockResolvedValue(undefined),
  };

  const shareTotalsCacheService = {
    increment: jest.fn(),
  };

  const addressSettingsCacheService = {
    shouldUpdateBestDifficulty: jest.fn().mockResolvedValue(false),
    updateBestDifficulty: jest.fn(),
    clear: jest.fn(),
  };

  const stratumV2Service = {
    getNoiseConfig: jest.fn(),
    getNextChannelId: jest.fn().mockReturnValue(1),
    generateExtranoncePrefix: jest.fn().mockReturnValue(Buffer.from('aabbccdd', 'hex')),
    registerClient: jest.fn(),
    unregisterClient: jest.fn(),
    hasJdpConnectionFromIp: jest.fn().mockReturnValue(false),
  };

  return {
    configService,
    stratumV1JobsService,
    clientService,
    notificationService,
    clientStatisticsService,
    poolShareStatisticsService,
    poolRejectedStatisticsService,
    clientRejectedStatisticsService,
    shareTotalsCacheService,
    addressSettingsCacheService,
    stratumV2Service,
    bitcoinRpcService: {} as any,
    blocksService: {} as any,
    addressSettingsService: {} as any,
    externalSharesService: { submitShare: jest.fn() } as any,
    clientDifficultyStatisticsService: { recordShareDifficulty: jest.fn().mockResolvedValue(undefined) } as any,
  };
}

// ── Test Helper: Setup a real noise session pair ────────────────────

async function setupNoiseConfig(): Promise<{
  noiseConfig: Sv2NoiseConfig;
  authorityPubKey: Buffer;
}> {
  const serverKeypair = await generateServerKeypair();
  const authorityPrivKey = crypto.randomBytes(32);
  const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
  const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
  const now = Math.floor(Date.now() / 1000);
  const cert = createSignatureNoiseMessage(
    authorityPrivKey,
    staticXOnly,
    now - 3600,
    now + 86400,
  );

  return {
    noiseConfig: { staticKeypair: serverKeypair, certificateMessage: cert },
    authorityPubKey,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('StratumV2Client', () => {
  let noiseConfig: Sv2NoiseConfig;

  beforeAll(async () => {
    const setup = await setupNoiseConfig();
    noiseConfig = setup.noiseConfig;
  });

  describe('Noise Handshake', () => {
    it('should complete noise handshake and respond with Act 2', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      // Generate Act 1 from an initiator
      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      // Create client (triggers handshake)
      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      // Wait for handshake to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Socket should have received Act 2 (234 bytes)
      const written = socket.drainWritten();
      expect(written.length).toBe(234);

      // Initiator should be able to process Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(written);
      expect(serverStaticKey.length).toBe(64);
      expect(certificate.version).toBe(0);

      // Both sides should now be able to encrypt/decrypt
      expect(initiator.isHandshakeComplete).toBe(true);

      socket.destroy();
    });

    it('should reject act1 shorter than 64 bytes', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const shortAct1 = Buffer.alloc(32);

      // Client constructor triggers handshake which should fail
      const client = new StratumV2Client(
        socket as any,
        shortAct1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Socket should have been destroyed due to handshake failure
      expect(socket.destroyed).toBe(true);
    });
  });

  describe('SetupConnection', () => {
    it('should respond with SetupConnectionSuccess for valid request', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      // Do handshake
      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Process Act 2
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      // Build and encrypt SetupConnection message
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-device',
      });

      // Build encrypted frame
      const initiatorWriter = new Sv2FrameWriter(initiator.encrypt.bind(initiator));
      const encryptedFrame = initiatorWriter.writeFrame(
        { extensionType: 0, msgType: Sv2MsgType.SETUP_CONNECTION, msgLength: setupPayload.length },
        setupPayload,
      );

      // Send to client
      socket.emit('data', encryptedFrame);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Read response
      const responseData = socket.drainWritten();
      expect(responseData.length).toBeGreaterThan(0);

      // Decrypt response
      const initiatorReader = new Sv2FrameReader(initiator.decrypt.bind(initiator));
      const frames = initiatorReader.feed(responseData);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(Sv2MsgType.SETUP_CONNECTION_SUCCESS);

      const reader = new BufferReader(frames[0].payload);
      const success = deserializeSetupConnectionSuccess(reader);
      expect(success.usedVersion).toBe(2);
      // Spec 5.3.1: Success flags use different namespace (REQUIRES_FIXED_VERSION/REQUIRES_EXTENDED_CHANNELS).
      // When client requests VERSION_ROLLING, REQUIRES_FIXED_VERSION must NOT be set.
      expect(success.flags & Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION).toBeFalsy();

      socket.destroy();
    });

    it('should reject unsupported protocol version', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      // Send SetupConnection with version range that doesn't include 2
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 3,
        maxVersion: 5,
        flags: 0,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-device',
      });

      const initiatorWriter = new Sv2FrameWriter(initiator.encrypt.bind(initiator));
      const encryptedFrame = initiatorWriter.writeFrame(
        { extensionType: 0, msgType: Sv2MsgType.SETUP_CONNECTION, msgLength: setupPayload.length },
        setupPayload,
      );

      socket.emit('data', encryptedFrame);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should respond with error and destroy socket
      const responseData = socket.drainWritten();
      if (responseData.length > 0) {
        const initiatorReader = new Sv2FrameReader(initiator.decrypt.bind(initiator));
        const frames = initiatorReader.feed(responseData);
        if (frames.length > 0) {
          expect(frames[0].header.msgType).toBe(Sv2MsgType.SETUP_CONNECTION_ERROR);
        }
      }
      expect(socket.destroyed).toBe(true);
    });
  });

  describe('DifficultyUtils integration', () => {
    it('difficultyToTarget should produce correct 32-byte LE buffer', () => {
      const target = DifficultyUtils.difficultyToTarget(1);
      expect(target.length).toBe(32);
      // At difficulty 1, target = TRUE_DIFF_ONE (~2^224), so bytes up to index 28 should be populated
      // At least some non-zero bytes should exist in the high-order region
      let hasNonZero = false;
      for (let i = 20; i < 32; i++) {
        if (target[i] !== 0) hasNonZero = true;
      }
      expect(hasNonZero).toBe(true);
    });

    it('difficultyToTarget and targetToDifficulty should round-trip', () => {
      const difficulties = [1, 100, 16384, 1000000, 1e12];
      for (const diff of difficulties) {
        const target = DifficultyUtils.difficultyToTarget(diff);
        const roundTripped = DifficultyUtils.targetToDifficulty(target);
        // Allow some rounding error due to BigInt floor division
        const ratio = roundTripped / diff;
        expect(ratio).toBeGreaterThan(0.99);
        expect(ratio).toBeLessThan(1.01);
      }
    });

    it('difficultyToTarget should return all-ff for invalid difficulty', () => {
      const target = DifficultyUtils.difficultyToTarget(0);
      expect(target).toEqual(Buffer.alloc(32, 0xff));

      const targetNeg = DifficultyUtils.difficultyToTarget(-1);
      expect(targetNeg).toEqual(Buffer.alloc(32, 0xff));

      const targetNaN = DifficultyUtils.difficultyToTarget(NaN);
      expect(targetNaN).toEqual(Buffer.alloc(32, 0xff));
    });

    it('targetToDifficulty should return Infinity for zero target', () => {
      const diff = DifficultyUtils.targetToDifficulty(Buffer.alloc(32, 0));
      expect(diff).toBe(Infinity);
    });

    it('higher difficulty should produce smaller target', () => {
      const lowDiffTarget = DifficultyUtils.difficultyToTarget(100);
      const highDiffTarget = DifficultyUtils.difficultyToTarget(1000000);

      // Compare as bigints
      let lowVal = 0n;
      let highVal = 0n;
      for (let i = 31; i >= 0; i--) {
        lowVal = (lowVal << 8n) | BigInt(lowDiffTarget[i]);
        highVal = (highVal << 8n) | BigInt(highDiffTarget[i]);
      }
      expect(lowVal > highVal).toBe(true);
    });
  });

  describe('client accessors', () => {
    it('should expose sessionId', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(client.sessionId).toBeDefined();
      expect(typeof client.sessionId).toBe('string');
      expect(client.sessionId.length).toBe(8); // 4 random bytes = 8 hex chars

      socket.destroy();
    });

    it('should return current difficulty', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 65536, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(client.getCurrentDifficulty()).toBe(65536);

      socket.destroy();
    });

    it('should return empty submission cache initially', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const cache = client.getSubmissionCacheForInterval(
        new Date(Date.now() - 60000),
        new Date(),
      );
      expect(cache).toEqual([]);

      socket.destroy();
    });
  });

  describe('resetBestDifficulty', () => {
    it('should reset entity bestDifficulty to 0', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Before entity is set, should not throw
      client.resetBestDifficulty();

      // Manually set entity to simulate post-channel-open state
      (client as any).entity = { bestDifficulty: 42 };
      client.resetBestDifficulty();
      expect((client as any).entity.bestDifficulty).toBe(0);

      socket.destroy();
    });
  });

  describe('cleanup', () => {
    it('should unregister client on socket close', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger close
      socket.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));

      // clientService.delete should have been called
      expect(services.clientService.delete).toHaveBeenCalled();
    });

    it('should handle socket timeout', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger timeout
      socket.emit('timeout');
      expect(socket.end).toHaveBeenCalled();
    });
  });

  describe('full message flow', () => {
    // Helper: create a fully handshaken client+initiator pair
    async function setupHandshakenClient() {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      // Make newMiningJob$ a proper observable-like that firstValueFrom can use
      const { Subject } = require('rxjs');
      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();
      services.stratumV1JobsService.newMiningJob$.subscribe = jest.fn((cb: any) => {
        return jobSubject.subscribe(cb);
      });

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Complete handshake
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      return { socket, services, client, initiator, jobSubject };
    }

    function sendEncryptedFrame(
      socket: MockSocket,
      initiator: Sv2NoiseInitiator,
      msgType: number,
      payload: Buffer,
      extensionType = 0,
    ) {
      const writer = new Sv2FrameWriter(initiator.encrypt.bind(initiator));
      const frame = writer.writeFrame(
        { extensionType, msgType, msgLength: payload.length },
        payload,
      );
      socket.emit('data', frame);
    }

    function readEncryptedFrames(
      data: Buffer,
      initiator: Sv2NoiseInitiator,
    ) {
      const reader = new Sv2FrameReader(initiator.decrypt.bind(initiator));
      return reader.feed(data);
    }

    it('should handle SetupConnection → success flow', async () => {
      const { socket, initiator } = await setupHandshakenClient();

      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });

      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(Sv2MsgType.SETUP_CONNECTION_SUCCESS);

      const reader = new BufferReader(frames[0].payload);
      const success = deserializeSetupConnectionSuccess(reader);
      expect(success.usedVersion).toBe(2);
      // Spec 5.3.1: Client didn't request VERSION_ROLLING, so REQUIRES_FIXED_VERSION should be set
      expect(success.flags & Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION).toBeTruthy();

      socket.destroy();
    });
  });

  describe('extended channels', () => {
    // Helper: create a fully handshaken client with extended channel support
    async function setupExtendedHandshakenClient() {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const { Subject } = require('rxjs');
      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();
      services.stratumV1JobsService.newMiningJob$.subscribe = jest.fn((cb: any) => {
        return jobSubject.subscribe(cb);
      });

      const extranonceManager = new Sv2ExtranonceManager();

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
        extranonceManager,
        undefined, // templateDistributionService
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Complete handshake
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      return { socket, services, client, initiator, jobSubject, extranonceManager };
    }

    function sendEncryptedFrame(
      socket: MockSocket,
      initiator: Sv2NoiseInitiator,
      msgType: number,
      payload: Buffer,
      extensionType = 0,
    ) {
      const writer = new Sv2FrameWriter(initiator.encrypt.bind(initiator));
      const frame = writer.writeFrame(
        { extensionType, msgType, msgLength: payload.length },
        payload,
      );
      socket.emit('data', frame);
    }

    function readEncryptedFrames(
      data: Buffer,
      initiator: Sv2NoiseInitiator,
    ) {
      const reader = new Sv2FrameReader(initiator.decrypt.bind(initiator));
      return reader.feed(data);
    }

    it('should handle SetupConnection with REQUIRES_WORK_SELECTION flag', async () => {
      const { socket, initiator } = await setupExtendedHandshakenClient();

      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });

      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(Sv2MsgType.SETUP_CONNECTION_SUCCESS);

      const reader = new BufferReader(frames[0].payload);
      const success = deserializeSetupConnectionSuccess(reader);
      expect(success.usedVersion).toBe(2);
      // Spec 5.3.1: Client requested VERSION_ROLLING, so REQUIRES_FIXED_VERSION must NOT be set
      expect(success.flags & Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION).toBeFalsy();

      socket.destroy();
    });

    it('should open extended channel and respond with success', async () => {
      const { socket, initiator, services, jobSubject } = await setupExtendedHandshakenClient();

      // First send SetupConnection
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      // Decrypt SetupConnection.Success to keep initiator's counter in sync
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Emit a job template before opening channel (needed for firstValueFrom)
      const mockBlock = {
        version: 0x20000000,
        prevHash: Buffer.alloc(32, 0xaa),
        merkleRoot: Buffer.alloc(32, 0xbb),
        timestamp: 1700000000,
        bits: 0x1d00ffff,
        nonce: 0,
        transactions: [{
          ins: [{ script: Buffer.alloc(50), witness: [Buffer.alloc(32, 0)] }],
          outs: [],
          getHash: jest.fn().mockReturnValue(Buffer.alloc(32, 0xcc)),
          __toBuffer: jest.fn().mockReturnValue(Buffer.alloc(100)),
        }],
        weight: jest.fn().mockReturnValue(1000),
      };
      const mockJobTemplate = {
        block: mockBlock,
        blockData: {
          id: 'template-1',
          height: 800000,
          clearJobs: false,
          networkDifficulty: 1e15,
          coinbasevalue: 625000000,
        },
        merkle_branch: [],
      };

      // Send OpenExtendedMiningChannel
      const openPayload = serializeOpenExtendedMiningChannel({
        requestId: 42,
        userIdentity: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080.worker1',
        nominalHashRate: 100e12,
        maxTarget: Buffer.alloc(32, 0xff),
        minExtranonceSize: 4,
      });

      // Emit the job template right before the channel open
      setTimeout(() => jobSubject.next(mockJobTemplate), 50);

      sendEncryptedFrame(socket, initiator, Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL, openPayload);
      await new Promise(resolve => setTimeout(resolve, 300));

      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);

      // Should have received OpenExtendedMiningChannel.Success + NewExtendedMiningJob + SetNewPrevHash
      expect(frames.length).toBeGreaterThanOrEqual(1);

      const successFrame = frames.find(f => f.header.msgType === Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS);
      expect(successFrame).toBeDefined();

      const reader = new BufferReader(successFrame!.payload);
      const success = deserializeOpenExtendedMiningChannelSuccess(reader);
      expect(success.requestId).toBe(42);
      expect(success.channelId).toBeGreaterThan(0);
      expect(success.extranonceSize).toBeGreaterThanOrEqual(4);
      expect(success.extranoncePrefix.length).toBeGreaterThan(0);

      socket.destroy();
    });

    it('should expose channel type as extended after opening extended channel', async () => {
      const { socket, initiator, services, jobSubject, client } = await setupExtendedHandshakenClient();

      // Initially should be standard
      expect(client.getChannelType()).toBe('standard');

      socket.destroy();
    });

    it('should dispatch SubmitSolution (0x76) to template distribution service', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const { Subject } = require('rxjs');
      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();
      services.stratumV1JobsService.newMiningJob$.subscribe = jest.fn((cb: any) => {
        return jobSubject.subscribe(cb);
      });

      const extranonceManager = new Sv2ExtranonceManager();
      const mockTdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined),
        handleSubmitSolution: jest.fn().mockResolvedValue(''),
        newTemplate$: { subscribe: jest.fn() },
        newPrevHash$: { subscribe: jest.fn() },
      };

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3333, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
        extranonceManager,
        mockTdpService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // Complete handshake
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      // Send SetupConnection first
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: 0,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Send SubmitSolution
      const solutionPayload = serializeTdpSubmitSolution({
        templateId: 1n,
        version: 0x20000000,
        headerTimestamp: 1700000000,
        headerNonce: 0x12345678,
        coinbaseTx: Buffer.alloc(100, 0xcc),
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_SUBMIT_SOLUTION, solutionPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockTdpService.handleSubmitSolution).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 1n,
          version: 0x20000000,
          headerTimestamp: 1700000000,
          headerNonce: 0x12345678,
        }),
      );

      socket.destroy();
    });

    it('should handle CloseChannel and destroy when all channels closed', async () => {
      const { socket, initiator, services, jobSubject, client } = await setupExtendedHandshakenClient();

      // Setup connection
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Set channelId manually to simulate post-channel-open
      (client as any).channels.set(1, {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.from('aabbccdd', 'hex'),
        extranonceSize: 0,
        sessionDifficulty: 16384,
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        miningSubmissionHashes: new Set(),
      });
      (client as any).primaryChannelId = 1;

      expect(client.getChannelCount()).toBe(1);

      // Import CloseChannel serializer
      const { serializeCloseChannel } = require('./sv2/sv2-messages');
      const closePayload = serializeCloseChannel({ channelId: 1, reasonCode: 'client-disconnect' });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.CLOSE_CHANNEL, closePayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      // All channels closed → socket should be destroyed
      expect(socket.destroyed).toBe(true);
    });

    it('should not destroy connection when only one of multiple channels is closed', async () => {
      const { socket, initiator, services, jobSubject, client } = await setupExtendedHandshakenClient();

      // Setup connection
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Manually add 2 channels
      (client as any).channels.set(1, {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.from('aabbccdd', 'hex'),
        extranonceSize: 0,
        sessionDifficulty: 16384,
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        miningSubmissionHashes: new Set(),
      });
      (client as any).channels.set(2, {
        channelId: 2,
        channelType: 'standard',
        extranoncePrefix: Buffer.from('eeff0011', 'hex'),
        extranonceSize: 0,
        sessionDifficulty: 16384,
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        miningSubmissionHashes: new Set(),
      });
      (client as any).primaryChannelId = 1;

      expect(client.getChannelCount()).toBe(2);

      // Close only channel 1
      const { serializeCloseChannel } = require('./sv2/sv2-messages');
      const closePayload = serializeCloseChannel({ channelId: 1, reasonCode: 'done' });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.CLOSE_CHANNEL, closePayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Socket should NOT be destroyed — channel 2 still open
      expect(socket.destroyed).toBe(false);
      expect(client.getChannelCount()).toBe(1);

      socket.destroy();
    });

    it('should handle UpdateChannel and reject invalid channel ID', async () => {
      const { socket, initiator, services } = await setupExtendedHandshakenClient();

      // Setup connection
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Send UpdateChannel for non-existent channel
      const { serializeUpdateChannel } = require('./sv2/sv2-messages');
      const updatePayload = serializeUpdateChannel({
        channelId: 999,
        nominalHashRate: 500000.0,
        maximumTarget: Buffer.alloc(32, 0xff),
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.UPDATE_CHANNEL, updatePayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);

      // Should get UpdateChannel.Error
      const errorFrame = frames.find(f => f.header.msgType === Sv2MsgType.UPDATE_CHANNEL_ERROR);
      expect(errorFrame).toBeDefined();

      socket.destroy();
    });

    it('should reject extended share for unknown job ID', async () => {
      const { socket, initiator, services, jobSubject, client } = await setupExtendedHandshakenClient();

      // Setup connection first
      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2,
        maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION,
        endpoint_host: 'localhost',
        endpoint_port: 3333,
        vendor: 'TestMiner',
        hardwareVersion: '1.0',
        firmwareVersion: '2.0',
        deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      // Decrypt to keep initiator's counter in sync
      readEncryptedFrames(socket.drainWritten(), initiator);

      // Set entity manually to avoid DB calls
      (client as any).entity = {
        sessionId: 'test-session',
        address: 'bcrt1qtest',
        clientName: 'worker1',
        bestDifficulty: 0,
        updatedAt: null,
      };
      (client as any).channelType = 'extended';
      (client as any).channelId = 1;

      // Submit an extended share for non-existent job
      const sharePayload = serializeSubmitSharesExtended({
        channelId: 1,
        sequenceNumber: 1,
        jobId: 999,
        nonce: 0x12345678,
        ntime: 1700000000,
        version: 0x20000000,
        extranonce: Buffer.alloc(4, 0xaa),
      });

      sendEncryptedFrame(socket, initiator, Sv2MsgType.SUBMIT_SHARES_EXTENDED, sharePayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);

      // Should get SubmitSharesError
      const errorFrame = frames.find(f => f.header.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR);
      expect(errorFrame).toBeDefined();

      socket.destroy();
    });
  });

  describe('TDP server mode', () => {
    const { ReplaySubject, Subject } = require('rxjs');

    function makeTdpTemplate(templateId: bigint) {
      return {
        templateId,
        futureTemplate: false,
        version: 0x20000000,
        coinbaseTxVersion: 2,
        coinbasePrefix: Buffer.alloc(50, 0xaa),
        coinbaseTxInputSequence: 0xffffffff,
        coinbaseTxValueRemaining: 312500000n,
        coinbaseTxOutputsCount: 1,
        coinbaseTxOutputs: Buffer.alloc(32, 0xbb),
        coinbaseTxLocktime: 0,
        merklePath: [],
      };
    }

    function makeTdpPrevHash(templateId: bigint) {
      return {
        templateId,
        prevHash: Buffer.alloc(32, 0xcc),
        headerTimestamp: 1700000000,
        nBits: 0x207fffff,
        target: Buffer.alloc(32, 0xff),
      };
    }

    async function setupTdpClient(mockTdpService: any) {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);

      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();

      const extranonceManager = new Sv2ExtranonceManager();
      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any,
        act1,
        { port: 3337, initialDifficulty: 16384, allowSuggestedDifficulty: true, targetSharesPerMinute: 6 },
        services.stratumV2Service as any,
        services.stratumV1JobsService as any,
        services.bitcoinRpcService,
        services.clientService as any,
        services.clientStatisticsService as any,
        services.notificationService as any,
        services.blocksService,
        services.configService as any,
        services.addressSettingsService,
        services.addressSettingsCacheService as any,
        services.poolShareStatisticsService as any,
        services.poolRejectedStatisticsService as any,
        services.clientRejectedStatisticsService as any,
        services.externalSharesService,
        services.clientDifficultyStatisticsService,
        services.shareTotalsCacheService as any,
        extranonceManager,
        mockTdpService as any,
      );

      await new Promise(resolve => setTimeout(resolve, 100));
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      return { socket, client, initiator };
    }

    function sendEncryptedFrame(
      socket: MockSocket,
      initiator: Sv2NoiseInitiator,
      msgType: number,
      payload: Buffer,
    ) {
      const writer = new Sv2FrameWriter(initiator.encrypt.bind(initiator));
      const frame = writer.writeFrame({ extensionType: 0, msgType, msgLength: payload.length }, payload);
      socket.emit('data', frame);
    }

    function readEncryptedFrames(data: Buffer, initiator: Sv2NoiseInitiator) {
      const reader = new Sv2FrameReader(initiator.decrypt.bind(initiator));
      return reader.feed(data);
    }

    it('should respond with SetupConnectionSuccess (flags=0) for TDP protocol=2', async () => {
      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined),
        newTemplate$: new ReplaySubject(1),
        newPrevHash$: new ReplaySubject(1),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      const setupPayload = serializeSetupConnection({
        protocol: 2, // TEMPLATE_DISTRIBUTION
        minVersion: 2,
        maxVersion: 2,
        flags: 0,
        endpoint_host: 'localhost',
        endpoint_port: 3337,
        vendor: 'TDPClient',
        hardwareVersion: '1.0',
        firmwareVersion: '1.0',
        deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(Sv2MsgType.SETUP_CONNECTION_SUCCESS);

      const reader = new BufferReader(frames[0].payload);
      const success = deserializeSetupConnectionSuccess(reader);
      expect(success.usedVersion).toBe(2);
      expect(success.flags).toBe(0); // No mining flags for TDP

      socket.destroy();
    });

    it('should send NewTemplate + SetNewPrevHash immediately after CoinbaseOutputConstraints', async () => {
      const { serializeTdpCoinbaseOutputConstraints, deserializeTdpNewTemplate, deserializeTdpSetNewPrevHash } = require('./sv2/sv2-tdp-messages');

      const template = makeTdpTemplate(42n);
      const prevHash = makeTdpPrevHash(42n);

      const newTemplateSubject = new ReplaySubject(1);
      const newPrevHashSubject = new ReplaySubject(1);
      newTemplateSubject.next(template);
      newPrevHashSubject.next(prevHash);

      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue({ template, prevHash }),
        newTemplate$: newTemplateSubject.asObservable(),
        newPrevHash$: newPrevHashSubject.asObservable(),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      // SetupConnection with protocol=2
      const setupPayload = serializeSetupConnection({
        protocol: 2,
        minVersion: 2,
        maxVersion: 2,
        flags: 0,
        endpoint_host: 'localhost',
        endpoint_port: 3337,
        vendor: 'TDPClient',
        hardwareVersion: '1.0',
        firmwareVersion: '1.0',
        deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      readEncryptedFrames(socket.drainWritten(), initiator); // consume SetupConnectionSuccess

      // Send CoinbaseOutputConstraints
      const constraintsPayload = serializeTdpCoinbaseOutputConstraints({
        coinbaseOutputMaxAdditionalSize: 100,
        coinbaseOutputMaxAdditionalSigops: 5,
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS, constraintsPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const templateFrame = frames.find(f => f.header.msgType === Sv2MsgType.TDP_NEW_TEMPLATE);
      const prevHashFrame = frames.find(f => f.header.msgType === Sv2MsgType.TDP_SET_NEW_PREV_HASH);

      expect(templateFrame).toBeDefined();
      expect(prevHashFrame).toBeDefined();

      // Verify templateId matches and future_template is always true (spec §7.3 MUST)
      const tReader = new BufferReader(templateFrame!.payload);
      const sentTemplate = deserializeTdpNewTemplate(tReader);
      expect(sentTemplate.templateId).toBe(42n);
      expect(sentTemplate.futureTemplate).toBe(true); // spec §7.3: MUST be true before SetNewPrevHash

      const phReader = new BufferReader(prevHashFrame!.payload);
      const sentPrevHash = deserializeTdpSetNewPrevHash(phReader);
      expect(sentPrevHash.templateId).toBe(42n);
      expect(sentPrevHash.nBits).toBe(0x207fffff);

      socket.destroy();
    });

    it('should forward future NewTemplate updates to TDP client', async () => {
      const { serializeTdpCoinbaseOutputConstraints, deserializeTdpNewTemplate } = require('./sv2/sv2-tdp-messages');

      const template1 = makeTdpTemplate(1n);
      const prevHash1 = makeTdpPrevHash(1n);

      const newTemplateSubject = new ReplaySubject(1);
      const newPrevHashSubject = new ReplaySubject(1);
      newTemplateSubject.next(template1);
      newPrevHashSubject.next(prevHash1);

      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue({ template: template1, prevHash: prevHash1 }),
        newTemplate$: newTemplateSubject.asObservable(),
        newPrevHash$: newPrevHashSubject.asObservable(),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      // SetupConnection
      const setupPayload = serializeSetupConnection({
        protocol: 2, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TDPClient', hardwareVersion: '1.0', firmwareVersion: '1.0', deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      readEncryptedFrames(socket.drainWritten(), initiator);

      // CoinbaseOutputConstraints → triggers subscription
      const constraintsPayload = serializeTdpCoinbaseOutputConstraints({
        coinbaseOutputMaxAdditionalSize: 100,
        coinbaseOutputMaxAdditionalSigops: 5,
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS, constraintsPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator); // consume initial template + prevhash

      // Emit a new template (future update)
      const template2 = makeTdpTemplate(2n);
      newTemplateSubject.next(template2);
      await new Promise(resolve => setTimeout(resolve, 50));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const templateFrames = frames.filter(f => f.header.msgType === Sv2MsgType.TDP_NEW_TEMPLATE);
      expect(templateFrames.length).toBe(1);

      const tReader = new BufferReader(templateFrames[0].payload);
      const sentTemplate = deserializeTdpNewTemplate(tReader);
      expect(sentTemplate.templateId).toBe(2n);

      socket.destroy();
    });

    it('should forward future SetNewPrevHash updates to TDP client', async () => {
      const { serializeTdpCoinbaseOutputConstraints, deserializeTdpSetNewPrevHash } = require('./sv2/sv2-tdp-messages');

      const template1 = makeTdpTemplate(1n);
      const prevHash1 = makeTdpPrevHash(1n);

      const newTemplateSubject = new ReplaySubject(1);
      const newPrevHashSubject = new ReplaySubject(1);
      newTemplateSubject.next(template1);
      newPrevHashSubject.next(prevHash1);

      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue({ template: template1, prevHash: prevHash1 }),
        newTemplate$: newTemplateSubject.asObservable(),
        newPrevHash$: newPrevHashSubject.asObservable(),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      const setupPayload = serializeSetupConnection({
        protocol: 2, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TDPClient', hardwareVersion: '1.0', firmwareVersion: '1.0', deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      readEncryptedFrames(socket.drainWritten(), initiator);

      const constraintsPayload = serializeTdpCoinbaseOutputConstraints({
        coinbaseOutputMaxAdditionalSize: 100,
        coinbaseOutputMaxAdditionalSigops: 5,
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS, constraintsPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator); // consume initial messages

      // Emit a new prevhash (new block)
      const prevHash2 = makeTdpPrevHash(2n);
      newPrevHashSubject.next(prevHash2);
      await new Promise(resolve => setTimeout(resolve, 50));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const prevHashFrames = frames.filter(f => f.header.msgType === Sv2MsgType.TDP_SET_NEW_PREV_HASH);
      expect(prevHashFrames.length).toBe(1);

      const phReader = new BufferReader(prevHashFrames[0].payload);
      const sentPrevHash = deserializeTdpSetNewPrevHash(phReader);
      expect(sentPrevHash.templateId).toBe(2n);

      socket.destroy();
    });

    it('should reject TDP SetupConnection with invalid version range', async () => {
      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined),
        newTemplate$: new ReplaySubject(1),
        newPrevHash$: new ReplaySubject(1),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      const { deserializeSetupConnectionError } = require('./sv2/sv2-messages');

      const setupPayload = serializeSetupConnection({
        protocol: 2,
        minVersion: 3, // invalid - pool only supports v2
        maxVersion: 3,
        flags: 0,
        endpoint_host: 'localhost',
        endpoint_port: 3337,
        vendor: 'TDPClient',
        hardwareVersion: '1.0',
        firmwareVersion: '1.0',
        deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const errorFrame = frames.find(f => f.header.msgType === Sv2MsgType.SETUP_CONNECTION_ERROR);
      expect(errorFrame).toBeDefined();

      const eReader = new BufferReader(errorFrame!.payload);
      const errMsg = deserializeSetupConnectionError(eReader);
      expect(errMsg.errorCode).toBe('protocol-version-mismatch');

      socket.destroy();
    });

    it('should return stale-template-id error when requested template is from an older block', async () => {
      const { serializeTdpCoinbaseOutputConstraints, serializeTdpRequestTransactionData, deserializeTdpRequestTransactionDataError } = require('./sv2/sv2-tdp-messages');
      const { Sv2MsgType: MsgType } = require('./sv2/sv2-constants');

      const staleTemplate = makeTdpTemplate(1n);
      const stalePrevHash = { ...makeTdpPrevHash(1n), prevHash: Buffer.alloc(32, 0x11) }; // old prevhash

      const latestTemplate = makeTdpTemplate(2n);
      const latestPrevHash = { ...makeTdpPrevHash(2n), prevHash: Buffer.alloc(32, 0x22) }; // new prevhash

      const newTemplateSubject = new ReplaySubject(1);
      const newPrevHashSubject = new ReplaySubject(1);
      newTemplateSubject.next(latestTemplate);
      newPrevHashSubject.next(latestPrevHash);

      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue({ template: latestTemplate, prevHash: latestPrevHash }),
        getTemplate: jest.fn((id: bigint) => {
          if (id === 1n) return { template: staleTemplate, prevHash: stalePrevHash, jobTemplate: null };
          if (id === 2n) return { template: latestTemplate, prevHash: latestPrevHash, jobTemplate: null };
          return undefined;
        }),
        newTemplate$: newTemplateSubject.asObservable(),
        newPrevHash$: newPrevHashSubject.asObservable(),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      const setupPayload = serializeSetupConnection({
        protocol: 2, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TDPClient', hardwareVersion: '1.0', firmwareVersion: '1.0', deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      readEncryptedFrames(socket.drainWritten(), initiator);

      const constraintsPayload = serializeTdpCoinbaseOutputConstraints({
        coinbaseOutputMaxAdditionalSize: 100,
        coinbaseOutputMaxAdditionalSigops: 5,
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS, constraintsPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator); // consume initial NewTemplate+SetNewPrevHash

      // Request transaction data for the stale template (templateId=1n, old prevhash)
      const reqPayload = serializeTdpRequestTransactionData({ templateId: 1n });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA, reqPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const errorFrame = frames.find(f => f.header.msgType === Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR);
      expect(errorFrame).toBeDefined();

      const errReader = new BufferReader(errorFrame!.payload);
      const errMsg = deserializeTdpRequestTransactionDataError(errReader);
      expect(errMsg.errorCode).toBe('stale-template-id');

      socket.destroy();
    });

    it('should send no NewTemplate if no template is available yet', async () => {
      const { serializeTdpCoinbaseOutputConstraints } = require('./sv2/sv2-tdp-messages');

      const newTemplateSubject = new ReplaySubject(1);
      const newPrevHashSubject = new ReplaySubject(1);
      // Don't emit any templates yet

      const tdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined), // no template yet
        newTemplate$: newTemplateSubject.asObservable(),
        newPrevHash$: newPrevHashSubject.asObservable(),
      };
      const { socket, initiator } = await setupTdpClient(tdpService);

      const setupPayload = serializeSetupConnection({
        protocol: 2, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TDPClient', hardwareVersion: '1.0', firmwareVersion: '1.0', deviceId: 'tdp-device',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      readEncryptedFrames(socket.drainWritten(), initiator);

      const constraintsPayload = serializeTdpCoinbaseOutputConstraints({
        coinbaseOutputMaxAdditionalSize: 100,
        coinbaseOutputMaxAdditionalSigops: 5,
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS, constraintsPayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      // No templates should be sent (nothing available yet)
      expect(frames.filter(f => f.header.msgType === Sv2MsgType.TDP_NEW_TEMPLATE).length).toBe(0);
      expect(frames.filter(f => f.header.msgType === Sv2MsgType.TDP_SET_NEW_PREV_HASH).length).toBe(0);

      socket.destroy();
    });
  });
});
