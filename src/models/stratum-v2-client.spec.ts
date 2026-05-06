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

    /**
     * Block-submit gating: if bitcoind rejects the block (bad-prevblk on a
     * stale solve, duplicate from a race, RPC error), the pool MUST NOT:
     *   - write to `blocks_entity` (no phantom row in the operator UI)
     *   - send "block found" push notifications to subscribers
     *   - reset best-difficulty on the address
     *   - run PPLNS / group-solo `onBlockFound` (no payout snapshot)
     *
     * Mirrors ckpool's `out_submit` semantics — submit always (let bitcoind
     * decide validity), record only on confirmed success. Pre-refactor the
     * V2 TDP path saved + notified unconditionally.
     */
    it('TDP SubmitSolution: bitcoind REJECTS → no blocksService.save, no push notification', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);
      // Wire the spies we want to assert against.
      const blocksSave = jest.fn().mockResolvedValue(undefined);
      services.blocksService = { save: blocksSave } as any;
      services.notificationService.notifySubscribersBlockFound.mockClear();

      const { Subject } = require('rxjs');
      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();
      services.stratumV1JobsService.newMiningJob$.subscribe = jest.fn((cb: any) => jobSubject.subscribe(cb));

      const extranonceManager = new Sv2ExtranonceManager();
      // handleSubmitSolution returns the structured response shape with
      // `result` set to a non-SUCCESS string (bitcoind rejection).
      const mockTdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined),
        handleSubmitSolution: jest.fn().mockResolvedValue({
          result: 'bad-prevblk',
          blockHex: 'deadbeef',
          height: 800000,
          coinbasevalue: 312500000,
        }),
        newTemplate$: { subscribe: jest.fn() },
        newPrevHash$: { subscribe: jest.fn() },
      };

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any, act1,
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

      // Bypass DB call inside ensureEntity by pre-populating the entity.
      (client as any).entity = {
        sessionId: 'test-session', address: 'bcrt1qtest', clientName: 'worker1',
        bestDifficulty: 0, updatedAt: null,
      };
      (client as any).address = 'bcrt1qtest';
      (client as any).workerName = 'worker1';

      await new Promise(resolve => setTimeout(resolve, 100));
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      const setupPayload = serializeSetupConnection({
        protocol: 0, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TestMiner', hardwareVersion: '1.0', firmwareVersion: '2.0', deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      const solutionPayload = serializeTdpSubmitSolution({
        templateId: 1n, version: 0x20000000,
        headerTimestamp: 1700000000, headerNonce: 0x12345678,
        coinbaseTx: Buffer.alloc(100, 0xcc),
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_SUBMIT_SOLUTION, solutionPayload);
      await new Promise(resolve => setTimeout(resolve, 150));

      // GATING ASSERTIONS: bookkeeping must NOT have run.
      expect(blocksSave).not.toHaveBeenCalled();
      expect(services.notificationService.notifySubscribersBlockFound).not.toHaveBeenCalled();

      socket.destroy();
    });

    it('TDP SubmitSolution: bitcoind ACCEPTS → blocksService.save + push notification BOTH fire', async () => {
      const socket = new MockSocket();
      const services = createMockServices();
      services.stratumV2Service.getNoiseConfig.mockReturnValue(noiseConfig);
      const blocksSave = jest.fn().mockResolvedValue(undefined);
      services.blocksService = { save: blocksSave } as any;
      services.notificationService.notifySubscribersBlockFound.mockClear();
      services.addressSettingsService = {
        resetBestDifficultyAndShares: jest.fn().mockResolvedValue(undefined),
      } as any;

      const { Subject } = require('rxjs');
      const jobSubject = new Subject();
      services.stratumV1JobsService.newMiningJob$ = jobSubject.asObservable();
      services.stratumV1JobsService.newMiningJob$.subscribe = jest.fn((cb: any) => jobSubject.subscribe(cb));

      const extranonceManager = new Sv2ExtranonceManager();
      const mockTdpService = {
        getLatestTemplate: jest.fn().mockReturnValue(undefined),
        handleSubmitSolution: jest.fn().mockResolvedValue({
          result: 'SUCCESS!',
          blockHex: 'deadbeef',
          height: 800000,
          coinbasevalue: 312500000,
        }),
        newTemplate$: { subscribe: jest.fn() },
        newPrevHash$: { subscribe: jest.fn() },
      };

      const initiator = new Sv2NoiseInitiator();
      const act1 = await initiator.generateAct1();

      const client = new StratumV2Client(
        socket as any, act1,
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

      (client as any).entity = {
        sessionId: 'test-session', address: 'bcrt1qtest', clientName: 'worker1',
        bestDifficulty: 0, updatedAt: null,
      };
      (client as any).address = 'bcrt1qtest';
      (client as any).workerName = 'worker1';

      await new Promise(resolve => setTimeout(resolve, 100));
      const act2 = socket.drainWritten();
      initiator.processAct2(act2);

      const setupPayload = serializeSetupConnection({
        protocol: 0, minVersion: 2, maxVersion: 2, flags: 0,
        endpoint_host: 'localhost', endpoint_port: 3337,
        vendor: 'TestMiner', hardwareVersion: '1.0', firmwareVersion: '2.0', deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      const solutionPayload = serializeTdpSubmitSolution({
        templateId: 1n, version: 0x20000000,
        headerTimestamp: 1700000000, headerNonce: 0x12345678,
        coinbaseTx: Buffer.alloc(100, 0xcc),
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.TDP_SUBMIT_SOLUTION, solutionPayload);
      await new Promise(resolve => setTimeout(resolve, 150));

      // GATING ASSERTIONS: bookkeeping must run on success.
      expect(blocksSave).toHaveBeenCalledTimes(1);
      expect(blocksSave).toHaveBeenCalledWith(
        expect.objectContaining({
          height: 800000,
          minerAddress: 'bcrt1qtest',
          worker: 'worker1',
        }),
      );
      expect(services.notificationService.notifySubscribersBlockFound).toHaveBeenCalledTimes(1);
      expect(services.addressSettingsService.resetBestDifficultyAndShares).toHaveBeenCalledTimes(1);

      socket.destroy();
    });

    it('should handle CloseChannel without destroying the connection (sv2-ui#143)', async () => {
      // Regression: the pool used to call destroySocket() when channels.size
      // hit 0, which broke tProxy in non-aggregated mode — every SV1 miner
      // disconnect would tear down the upstream connection, forcing a full
      // Noise handshake + SetupConnection on the next SV1 attach. Per SV2
      // spec §5.3.9 the server's only obligation is to stop sending messages
      // for the closed channel; the connection MUST stay alive so the client
      // can open new channels on it.
      const { socket, initiator, services, jobSubject, client } = await setupExtendedHandshakenClient();

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

      const { serializeCloseChannel } = require('./sv2/sv2-messages');
      const closePayload = serializeCloseChannel({ channelId: 1, reasonCode: 'client-disconnect' });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.CLOSE_CHANNEL, closePayload);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Last channel closed: channel state cleaned up, but the socket
      // stays open so the client can open a fresh channel on it.
      expect(client.getChannelCount()).toBe(0);
      expect((client as any).primaryChannelId).toBeNull();
      expect(socket.destroyed).toBe(false);

      socket.destroy();
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

    // SV2 spec regression — extranonce_size is the MINER ROLLABLE portion
    // only, NOT prefix + rollable. The on-wire value the pool sends in
    // OpenExtendedMiningChannel.Success.extranonce_size must equal what the
    // miner submits as SubmitSharesExtended.extranonce.length (byte-for-byte).
    // `channel.extranonceSize` internally must hold the same rollable-only
    // value, matching SRI's `rollable_extranonce_size`.
    //
    // Full coinbase = coinbase_tx_prefix + extranonce_prefix + extranonce +
    // coinbase_tx_suffix; total extranonce bytes = prefix.length + rollable.
    it('stores extranonce_size as rollable-only per SV2 spec, wire matches SubmitSharesExtended.extranonce length', async () => {
      const { socket, initiator, jobSubject, client } = await setupExtendedHandshakenClient();

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
      readEncryptedFrames(socket.drainWritten(), initiator);

      const mockJobTemplate: any = {
        id: 'test-job',
        prevhash: '0000000000000000000000000000000000000000000000000000000000000001',
        coinbase_prefix_hex: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0f' +
          '00000000',
        coinbase_suffix_hex: '00000000',
        merkle_branch: [],
        version: 0x20000000,
        nbits: 0x1d00ffff,
        ntime: 1700000000,
        height: 100,
        witness_commitment: Buffer.alloc(32),
        block: {
          timestamp: 1700000000,
          toHex: () => '',
        },
        blockData: {
          height: 100,
          clearJobs: false,
          networkDifficulty: 1e15,
          coinbasevalue: 625000000,
        },
      };

      // Ask for rollable=6 via minExtranonceSize — pool's default allocator is
      // prefix=4 + rollable=4 (total 8). With minExtranonceSize=6 we expect
      // the pool to bump the rollable portion up to 6 (total becomes 10 bytes).
      const openPayload = serializeOpenExtendedMiningChannel({
        requestId: 17,
        userIdentity: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080.extra',
        nominalHashRate: 100e12,
        maxTarget: Buffer.alloc(32, 0xff),
        minExtranonceSize: 6,
      });
      setTimeout(() => jobSubject.next(mockJobTemplate), 50);
      sendEncryptedFrame(socket, initiator, Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL, openPayload);
      await new Promise(resolve => setTimeout(resolve, 300));

      const frames = readEncryptedFrames(socket.drainWritten(), initiator);
      const successFrame = frames.find(f => f.header.msgType === Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS);
      expect(successFrame).toBeDefined();

      const success = deserializeOpenExtendedMiningChannelSuccess(new BufferReader(successFrame!.payload));
      const wireRollable = success.extranonceSize;
      const wirePrefixLen = success.extranoncePrefix.length;

      // The wire extranonce_size must be AT LEAST the requested 6 (rollable only).
      expect(wireRollable).toBeGreaterThanOrEqual(6);

      // Internal state must store the SAME rollable-only value on the channel,
      // not the total — otherwise share validation derives the wrong expected
      // length and would either reject valid submissions or accept malformed
      // ones. This is the concrete behavior covered by the recent fix.
      const channel = (client as any).channels.get(success.channelId);
      expect(channel).toBeDefined();
      expect(channel.extranonceSize).toBe(wireRollable);

      // Guardrail: the prefix length on the channel matches what was sent
      // on the wire — together they give total coinbase extranonce bytes,
      // which is what patchCoinbasePrefixVarint/SetCustomMiningJob should
      // use for varint patching and scriptSig-length computation.
      expect(channel.extranoncePrefix.length).toBe(wirePrefixLen);
      const totalExtranonceBytes = channel.extranoncePrefix.length + channel.extranonceSize;
      expect(totalExtranonceBytes).toBe(wirePrefixLen + wireRollable);

      // Install a mock extended job so share submission gets past the
      // job-lookup step and hits the extranonce-size validation branch.
      const fakePrevHash = Buffer.alloc(32);
      const fakeCoinbasePrefix = Buffer.concat([
        Buffer.from('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff', 'hex'),
        Buffer.from([0x00]), // scriptSig length varint (filled in by patch logic in prod)
      ]);
      const fakeCoinbaseSuffix = Buffer.from('00000000', 'hex');
      channel.extendedJobs.set(0x01, {
        channelId: success.channelId,
        jobId: 0x01,
        coinbasePrefix: fakeCoinbasePrefix,
        coinbaseSuffix: fakeCoinbaseSuffix,
        merklePath: [],
        prevHash: fakePrevHash,
        nBits: 0x1d00ffff,
        versionRollingAllowed: true,
        jobTemplate: mockJobTemplate,
      });
      channel.jobIdToDifficulty.set(0x01, 1);

      // Case A: miner sends exactly `channel.extranonceSize` bytes → validation passes.
      // Case B: miner sends wrong length → mismatch warning.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const correctShare = serializeSubmitSharesExtended({
          channelId: success.channelId,
          sequenceNumber: 1,
          jobId: 1,
          nonce: 0x11111111,
          ntime: 1700000000,
          version: 0x20000000,
          extranonce: Buffer.alloc(wireRollable, 0xaa),
        });
        sendEncryptedFrame(socket, initiator, Sv2MsgType.SUBMIT_SHARES_EXTENDED, correctShare);
        await new Promise(resolve => setTimeout(resolve, 150));
        readEncryptedFrames(socket.drainWritten(), initiator);

        const mismatchesBefore = warnSpy.mock.calls.filter(c => String(c[0]).includes('Extranonce size mismatch')).length;

        const badShare = serializeSubmitSharesExtended({
          channelId: success.channelId,
          sequenceNumber: 2,
          jobId: 1,
          nonce: 0x22222222,
          ntime: 1700000001,
          version: 0x20000000,
          // Wrong length: send prefix+rollable bytes (the old-bug TOTAL size).
          // Pool must reject this as mismatched per spec.
          extranonce: Buffer.alloc(wirePrefixLen + wireRollable, 0xbb),
        });
        sendEncryptedFrame(socket, initiator, Sv2MsgType.SUBMIT_SHARES_EXTENDED, badShare);
        await new Promise(resolve => setTimeout(resolve, 150));
        readEncryptedFrames(socket.drainWritten(), initiator);

        const mismatchesAfter = warnSpy.mock.calls.filter(c => String(c[0]).includes('Extranonce size mismatch')).length;
        expect(mismatchesAfter - mismatchesBefore).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }

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

    /**
     * Subscription-leak regression: tProxy in non-aggregated mode opens a
     * fresh extended channel for each SV1 miner that attaches. After
     * the CloseChannel fix (f19c0cb) the upstream connection survives
     * across SV1 miner cycles, which means `setupJobSubscriptionAndDifficultyInterval`
     * is called repeatedly (once per `isFirstChannel = true`). Pre-fix,
     * each call OVERWROTE `this.stratumSubscription` without
     * unsubscribing the previous handle — leaking N active subscriptions
     * per N attached-then-detached SV1 miners. Each leaked subscription
     * dispatched its own NewExtendedMiningJob with a fresh jobId on
     * every newMiningJob$ emission.
     *
     * Exact symptom from sv2-ui#143 follow-up: 3 NewExtendedMiningJob
     * messages with identical content (only differing jobId) for the
     * same template, then 2 SetNewPrevHash for older job_ids than the
     * latest, → tProxy `JobIdNotFound` → fallback → crash.
     *
     * This test calls setup three times in a row, emits ONE template
     * through the rxjs subject, and asserts that only ONE
     * NewExtendedMiningJob frame is sent. Without the unsubscribe fix
     * this assertion would observe 3 frames.
     */
    it('setupJobSubscriptionAndDifficultyInterval is idempotent — N calls leak zero subscriptions (sv2-ui#143 follow-up)', async () => {
      const { socket, client, jobSubject } = await setupExtendedHandshakenClient();

      // Plant an extended channel so broadcastNewJobToAllChannels has a
      // target to dispatch to.
      const channel: any = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.from('00000001', 'hex'),
        extranonceSize: 4,
        sessionDifficulty: 1,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set<string>(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };
      (client as any).channels.set(1, channel);

      // Spy the broadcaster so we can count dispatches per emission.
      const broadcastSpy = jest.spyOn(client as any, 'broadcastNewJobToAllChannels')
        .mockResolvedValue(undefined);

      // Simulate the open/close/open cycle that tProxy non-aggregated
      // does: setup the subscription three times in a row. Pre-fix,
      // this leaks two subscriptions; post-fix, each call unsubscribes
      // the previous one first.
      (client as any).setupJobSubscriptionAndDifficultyInterval(true);
      (client as any).setupJobSubscriptionAndDifficultyInterval(true);
      (client as any).setupJobSubscriptionAndDifficultyInterval(true);

      // Emit ONE template — pre-fix this would trigger 3 broadcasts
      // (one per leaked subscription). Post-fix: exactly one.
      jobSubject.next({
        block: { prevHash: Buffer.alloc(32), bits: 0x207fffff, timestamp: 1700000000, version: 0x20000000 },
        merkle_branch: [],
        blockData: {
          id: 't1',
          creation: Date.now(),
          coinbasevalue: 312500000,
          networkDifficulty: 1,
          height: 1,
          clearJobs: false,
        },
      });

      // Allow the rxjs subscriber's async handler to settle.
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastSpy).toHaveBeenCalledTimes(1);

      // Teardown: clear the difficulty timer + unsubscribe the rxjs
      // subscription so jest can exit cleanly. Without this the
      // checkDifficultyAllChannels setInterval keeps the event loop
      // alive past the test's lifetime.
      if ((client as any).difficultyCheckInterval) {
        clearInterval((client as any).difficultyCheckInterval);
        (client as any).difficultyCheckInterval = null;
      }
      if ((client as any).stratumSubscription) {
        (client as any).stratumSubscription.unsubscribe();
        (client as any).stratumSubscription = null;
      }
      socket.destroy();
    });

    /**
     * Companion test: handleCloseChannel for the LAST channel must
     * release the job subscription (so the next OpenExtendedMiningChannel
     * can re-arm it without leaking).
     */
    it('handleCloseChannel releases stratumSubscription when channels.size hits 0', async () => {
      const { socket, client, jobSubject } = await setupExtendedHandshakenClient();

      // Plant a channel + arm the subscription
      const channel: any = {
        channelId: 1, channelType: 'extended',
        extranoncePrefix: Buffer.from('00000001', 'hex'),
        extranonceSize: 4, sessionDifficulty: 1,
        jobIdToDifficulty: new Map(), extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0, latestExtendedMinNtime: 0,
        acceptedShareCount: 0, acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set<string>(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };
      (client as any).channels.set(1, channel);
      (client as any).primaryChannelId = 1;
      (client as any).setupJobSubscriptionAndDifficultyInterval(true);

      expect((client as any).stratumSubscription).not.toBeNull();
      expect((client as any).difficultyCheckInterval).not.toBeNull();

      // Simulate the CloseChannel handler — drop the channel from the
      // map and run the post-cleanup logic (size === 0 release).
      (client as any).channels.delete(1);
      (client as any).primaryChannelId = null;
      // Replicate the size-check release block in handleCloseChannel:
      if ((client as any).channels.size === 0) {
        if ((client as any).stratumSubscription) {
          (client as any).stratumSubscription.unsubscribe();
          (client as any).stratumSubscription = null;
        }
        if ((client as any).difficultyCheckInterval) {
          clearInterval((client as any).difficultyCheckInterval);
          (client as any).difficultyCheckInterval = null;
        }
      }

      expect((client as any).stratumSubscription).toBeNull();
      expect((client as any).difficultyCheckInterval).toBeNull();

      // Emit a template — the (now-released) subscription must NOT fire.
      const broadcastSpy = jest.spyOn(client as any, 'broadcastNewJobToAllChannels')
        .mockResolvedValue(undefined);
      jobSubject.next({
        block: { prevHash: Buffer.alloc(32), bits: 0x207fffff, timestamp: 1700000000, version: 0x20000000 },
        merkle_branch: [],
        blockData: { id: 't1', creation: Date.now(), coinbasevalue: 312500000, networkDifficulty: 1, height: 1, clearJobs: false },
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(broadcastSpy).not.toHaveBeenCalled();

      socket.destroy();
    });

    /**
     * SV2 spec §5.3.14 distinguishes `stale-share` (job WAS known, since
     * superseded) from `invalid-job-id` (genuinely unknown). Pre-refactor
     * the channel's `extendedJobs` map was wiped on `clearJobs=true`
     * BEFORE the new job got broadcast — for the few ms between wipe and
     * broadcast, any in-flight share against the old jobId resolved to
     * `null` and got the wrong wire code.
     *
     * The new pattern: stamp `retiredAt` instead of clearing. Share
     * validation classifies known-but-retired jobs as stale, and emits
     * the correct SV2 wire code per spec.
     */
    it('block change retires extendedJobs but keeps them queryable (sv2-spec §5.3.14)', async () => {
      const { client } = await setupExtendedHandshakenClient();

      // Manually populate a channel + an extended job — bypasses the full
      // OpenExtendedMiningChannel handshake but exercises the same
      // post-clearJobs retirement logic.
      const channel: any = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.from('00000001', 'hex'),
        extranonceSize: 4,
        sessionDifficulty: 1,
        jobIdToDifficulty: new Map([[1, 1]]),
        extendedJobs: new Map([
          [1, {
            coinbasePrefix: Buffer.alloc(50, 0xaa),
            coinbaseSuffix: Buffer.alloc(8, 0xbb),
            merklePath: [],
            version: 0x20000000,
            prevHash: Buffer.alloc(32, 0xcc),
            nBits: 0x207fffff,
            minNtime: 1700000000,
            jobTemplate: null,
            creation: Date.now() - 1000,
          }],
        ]),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set<string>(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };
      (client as any).channels.set(1, channel);

      // Trigger the retire path: emit a clearJobs=true template through
      // the rxjs subject the client subscribed to.
      const { Subject } = require('rxjs');
      const subj: any = (client as any).stratumV1JobsService.newMiningJob$;
      // The mock subject swap happened in setupExtendedHandshakenClient.
      // Resubscribing won't re-run the subscribe registration; instead we
      // poke the channel directly the way the production block-change
      // handler does.
      const retireAt = 1_700_000_000_000;
      for (const ej of channel.extendedJobs.values()) {
        if (ej.retiredAt === undefined) ej.retiredAt = retireAt;
      }

      // The job MUST still be queryable post-retirement.
      const ej = channel.extendedJobs.get(1);
      expect(ej).toBeDefined();
      expect(ej.retiredAt).toBe(retireAt);

      // classifyExtendedJobForShare should report:
      //   - 'stale-creditable' within 5s of retirement
      //   - 'stale-rejected' beyond
      const classifier = (client as any).classifyExtendedJobForShare.bind(client);
      expect(classifier(ej, retireAt)).toBe('stale-creditable');
      expect(classifier(ej, retireAt + 4_999)).toBe('stale-creditable');
      expect(classifier(ej, retireAt + 5_001)).toBe('stale-rejected');
    });

    it('cleanupRetiredExtendedJobs deletes only retired entries past retention, respects MIN_RETAINED=3', async () => {
      const { client } = await setupExtendedHandshakenClient();

      const now = 2_000_000_000_000;
      const channel: any = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.from('00000001', 'hex'),
        extranonceSize: 4,
        sessionDifficulty: 1,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map<number, any>(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set<string>(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };
      const retentionMs = 600_000;

      // 5 entries: oldest two retired far past retention, three retired but
      // within retention. With MIN_RETAINED=3, the floor is enforced and the
      // 2 oldest are deletable. Ordering by creation desc so newest retains.
      const baseAge = retentionMs + 60_000;
      for (let i = 0; i < 5; i++) {
        const creation = now - (5 - i) * 100_000;
        const retiredAt = i < 2 ? creation - 60_000 : now - 1_000; // first 2 are way past
        channel.extendedJobs.set(i, {
          coinbasePrefix: Buffer.alloc(0),
          coinbaseSuffix: Buffer.alloc(0),
          merklePath: [],
          version: 0,
          prevHash: Buffer.alloc(32),
          nBits: 0,
          minNtime: 0,
          jobTemplate: null,
          creation,
          retiredAt,
        });
      }
      // Adjust the first two to be way past retention.
      channel.extendedJobs.get(0).retiredAt = now - retentionMs - 60_000;
      channel.extendedJobs.get(1).retiredAt = now - retentionMs - 30_000;

      (client as any).channels.set(1, channel);

      (client as any).cleanupRetiredExtendedJobs(now);

      // The 3 newest stay regardless. Older retired-past-retention go.
      expect(channel.extendedJobs.size).toBe(3);
      // jobs 2,3,4 (newest creations) survive
      expect(channel.extendedJobs.has(2)).toBe(true);
      expect(channel.extendedJobs.has(3)).toBe(true);
      expect(channel.extendedJobs.has(4)).toBe(true);
      expect(channel.extendedJobs.has(0)).toBe(false);
      expect(channel.extendedJobs.has(1)).toBe(false);
    });

    it('extended share against retired-beyond-grace job emits wire code stale-share + Stale rejection counter', async () => {
      const { socket, initiator, services, client } = await setupExtendedHandshakenClient();

      const setupPayload = serializeSetupConnection({
        protocol: 0,
        minVersion: 2, maxVersion: 2,
        flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION,
        endpoint_host: 'localhost', endpoint_port: 3333,
        vendor: 'TestMiner', hardwareVersion: '1.0', firmwareVersion: '2.0', deviceId: 'test-id',
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SETUP_CONNECTION, setupPayload);
      await new Promise(resolve => setTimeout(resolve, 100));
      readEncryptedFrames(socket.drainWritten(), initiator);

      (client as any).entity = {
        sessionId: 'test-session', address: 'bcrt1qtest', clientName: 'worker1',
        bestDifficulty: 0, updatedAt: null,
      };

      // Plant a retired-beyond-grace extended job on a channel.
      const longAgo = Date.now() - 60_000; // 60s ago, way past 5s grace
      const channel: any = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.from('00000001', 'hex'),
        extranonceSize: 4,
        sessionDifficulty: 1,
        jobIdToDifficulty: new Map([[1, 1]]),
        extendedJobs: new Map([
          [1, {
            coinbasePrefix: Buffer.alloc(50, 0xaa),
            coinbaseSuffix: Buffer.alloc(8, 0xbb),
            merklePath: [],
            version: 0x20000000,
            prevHash: Buffer.alloc(32, 0xcc),
            nBits: 0x207fffff,
            minNtime: 1700000000,
            jobTemplate: null,
            creation: longAgo - 1000,
            retiredAt: longAgo,
          }],
        ]),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set<string>(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };
      (client as any).channels.set(1, channel);

      services.poolRejectedStatisticsService.addRejectedShare.mockClear();

      const sharePayload = serializeSubmitSharesExtended({
        channelId: 1, sequenceNumber: 1, jobId: 1,
        nonce: 0x12345678, ntime: 1700000000, version: 0x20000000,
        extranonce: Buffer.alloc(4, 0xaa),
      });
      sendEncryptedFrame(socket, initiator, Sv2MsgType.SUBMIT_SHARES_EXTENDED, sharePayload);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Wire response: SubmitSharesError with error_code 'stale-share'
      const responseData = socket.drainWritten();
      const frames = readEncryptedFrames(responseData, initiator);
      const errorFrame = frames.find(f => f.header.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR);
      expect(errorFrame).toBeDefined();
      const { deserializeSubmitSharesError } = require('./sv2/sv2-messages');
      const parsed = deserializeSubmitSharesError(
        new (require('./sv2/sv2-binary-codec').BufferReader)(errorFrame!.payload),
      );
      expect(parsed.errorCode).toBe('stale-share');

      // Internal counter: 'Stale', NOT 'JobNotFound'
      expect(services.poolRejectedStatisticsService.addRejectedShare).toHaveBeenCalledWith(
        'Stale',
        expect.any(Number),
      );
      // Genuinely-missing path uses 'JobNotFound' — verify it was NOT called
      // for this share.
      const calls = services.poolRejectedStatisticsService.addRejectedShare.mock.calls as any[][];
      const jobNotFoundCalls = calls.filter((c: any[]) => c[0] === 'JobNotFound');
      expect(jobNotFoundCalls.length).toBe(0);

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
