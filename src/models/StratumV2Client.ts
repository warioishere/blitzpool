import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { getAddressInfo } from 'bitcoin-address-validation';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, skip, Subscription } from 'rxjs';

import { recordConnectionFailure } from '../services/protocol-detector.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';
import { StratumPortConfig } from './interfaces/unified-stratum.interfaces';
import { StratumV2ChannelState, ExtendedJobData } from './interfaces/stratum-v2-channel.interface';
import { StratumV2Service } from '../services/stratum-v2.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { NotificationService } from '../services/notification.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { AddressSettingsCacheService } from '../services/address-settings-cache.service';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ShareTotalsCacheService } from '../services/share-totals-cache.service';
import { PplnsService } from '../services/pplns.service';
import { GroupSoloService } from '../services/group-solo.service';
import { MinerActiveModeService } from '../services/miner-active-mode.service';
import { patchCoinbasePrefixVarint } from '../utils/coinbase-prefix.utils';
import { PoolModeHashrateService } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { MiningJob } from './MiningJob';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { MAX_REASONABLE_DIFFICULTY } from '../constants/mining.constants';

import { Sv2NoiseSession } from './sv2/sv2-noise';
import { Sv2FrameReader, Sv2FrameWriter } from './sv2/sv2-frame';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
  Sv2MsgType,
  Sv2MiningSetupFlags,
  Sv2MiningSetupSuccessFlags,
  Sv2Protocol,
  SV2_NOISE_ACT1_SIZE,
  SV2_CHANNEL_MSG_FLAG,
} from './sv2/sv2-constants';
import {
  deserializeSetupConnection,
  serializeSetupConnectionSuccess,
  serializeSetupConnectionError,
  serializeOpenMiningChannelError,
  deserializeOpenStandardMiningChannel,
  serializeOpenStandardMiningChannelSuccess,
  serializeNewMiningJob,
  serializeSetNewPrevHash,
  deserializeSubmitSharesStandard,
  serializeSubmitSharesSuccess,
  serializeSubmitSharesError,
  serializeSetTarget,
  Sv2SubmitSharesStandard,
  deserializeCloseChannel,
  deserializeUpdateChannel,
  serializeUpdateChannelError,
  serializeReconnect,
  deserializeRequestExtensions,
  serializeRequestExtensionsSuccess,
  SV2_EXTENSION_NEGOTIATION_ID,
} from './sv2/sv2-messages';
import {
  deserializeOpenExtendedMiningChannel,
  serializeOpenExtendedMiningChannelSuccess,
  serializeNewExtendedMiningJob,
  deserializeSubmitSharesExtended,
  Sv2SubmitSharesExtended,
  serializeSetExtranoncePrefix,
  serializeSetGroupChannel,
} from './sv2/sv2-extended-messages';
import {
  serializeSetCustomMiningJob,
  deserializeSetCustomMiningJob,
  serializeSetCustomMiningJobSuccess,
  serializeSetCustomMiningJobError,
  Sv2DeclareMiningJob,
} from './sv2/sv2-jdp-messages';
import { Sv2ExtranonceManager } from './sv2/sv2-extranonce-manager';
import {
  deserializeTdpSubmitSolution,
  deserializeTdpCoinbaseOutputConstraints,
  deserializeTdpRequestTransactionData,
  serializeTdpRequestTransactionDataSuccess,
  serializeTdpRequestTransactionDataError,
  serializeTdpNewTemplate,
  serializeTdpSetNewPrevHash,
  Sv2TdpNewTemplate,
  Sv2TdpSetNewPrevHash,
} from './sv2/sv2-tdp-messages';
import { TemplateDistributionService } from '../services/template-distribution.service';
import { merkleBranchToBuffers } from '../utils/merkle.utils';

// ── Per-channel extended-job lifecycle constants ──────────────────────
//
// Mirrors `STALE_GRACE_MS` / `JOB_RETENTION_MS` in stratum-v1-jobs.service
// but scoped per SV2 connection. Per-channel maps used to be wiped on
// `clearJobs=true` BEFORE the new job got broadcast — opening the same
// in-flight-share race the central service had. Now the maps retire
// instead of wipe, and aging GCs entries past the retention window.
//
// SV2 spec §5.3.14 distinguishes `stale-share` from `invalid-job-id`,
// so the wire response can be precise: stale-share for retired-but-known
// jobs, invalid-job-id only when the entry has actually been GC'd.
const SV2_STALE_GRACE_MS = parseInt(process.env.SV2_STALE_GRACE_MS) || 5000;
const SV2_EXTENDED_JOB_RETENTION_MS = parseInt(process.env.SV2_EXTENDED_JOB_RETENTION_MS) || 600000;

const SV2_MSG_TYPE_NAMES: Record<number, string> = {
  0x00: 'SetupConnection',
  0x01: 'SetupConnectionSuccess',
  0x02: 'SetupConnectionError',
  0x04: 'Reconnect',
  0x10: 'OpenStandardMiningChannel',
  0x11: 'OpenStandardMiningChannelSuccess',
  0x12: 'OpenStandardMiningChannelError',
  0x13: 'OpenExtendedMiningChannel',
  0x14: 'OpenExtendedMiningChannelSuccess',
  0x15: 'NewMiningJob',
  0x16: 'UpdateChannel',
  0x17: 'UpdateChannelError',
  0x18: 'CloseChannel',
  0x19: 'SetExtranoncePrefix',
  0x1a: 'SubmitSharesStandard',
  0x1b: 'SubmitSharesExtended',
  0x1c: 'SubmitSharesSuccess',
  0x1d: 'SubmitSharesError',
  0x1f: 'NewExtendedMiningJob',
  0x20: 'SetNewPrevHash',
  0x21: 'SetTarget',
  0x22: 'SetCustomMiningJob',
  0x23: 'SetCustomMiningJobSuccess',
  0x24: 'SetCustomMiningJobError',
  0x25: 'SetGroupChannel',
  0x50: 'JDP_AllocateMiningJobToken',
  0x51: 'JDP_AllocateMiningJobTokenSuccess',
  0x55: 'JDP_ProvideMissingTransactions',
  0x56: 'JDP_ProvideMissingTransactionsSuccess',
  0x57: 'JDP_DeclareMiningJob',
  0x58: 'JDP_DeclareMiningJobSuccess',
  0x59: 'JDP_DeclareMiningJobError',
  0x60: 'JDP_SubmitSolution',
  0x70: 'TDP_CoinbaseOutputConstraints',
  0x71: 'TDP_NewTemplate',
  0x72: 'TDP_SetNewPrevHash',
  0x73: 'TDP_RequestTransactionData',
  0x74: 'TDP_RequestTransactionDataSuccess',
  0x75: 'TDP_RequestTransactionDataError',
  0x76: 'TDP_SubmitSolution',
};

export class StratumV2Client {
  // Connection state
  private noiseSession: Sv2NoiseSession;
  private frameReader: Sv2FrameReader;
  private frameWriter: Sv2FrameWriter;
  private destroyed = false;

  /**
   * Per-session accepted-share counter for the PPLNS warmup gate.
   * Mirrors the StratumV1 implementation: first `ledgerWarmupShares`
   * shares are validated + counted in client stats but skip the PPLNS
   * ledger write. Filters CPU / low-hashrate miners.
   */
  private acceptedShareCount = 0;

  // Multi-channel state
  private channels = new Map<number, StratumV2ChannelState>();
  private primaryChannelId: number | null = null;

  // Connection-level state
  private address: string | null = null;
  private workerName: string = 'default';
  private userAgent: string = '';
  private vendorInfo: string = '';
  public sessionId: string;
  private sessionStart: Date;

  // Mining state
  private sessionDifficulty: number;
  private statistics: StratumV1ClientStatistics;
  private stratumSubscription: Subscription | null = null;
  private difficultyCheckInterval: NodeJS.Timer | null = null;
  private entity: ClientEntity | null = null;
  private creatingEntity: Promise<void> | null = null;
  public hashRate: number = 0;
  public noFee: boolean = false;

  // TDP state
  private isTdpClient = false;
  private tdpSubscriptions: Subscription[] = [];
  private coinbaseOutputMaxAdditionalSize = 0;

  // Custom job ID counter (wraps at 0xFFFFFFFF)
  private nextCustomJobId = 1;

  // Notifications
  private deviceOnlineNotified = false;
  private deviceOfflineNotified = false;

  // Version rolling
  private versionRollingEnabled = false;
  private workSelectionEnabled = false;

  // Cached env flag for per-message debug logging
  private readonly debugMessages: boolean;

  private network: bitcoinjs.networks.Network;
  private difficultyCheckIntervalMs: number;
  private lastDifficultyCheck = 0;
  private jdShareCountAtLastCheck = 0;  // JD-client-only: share count at last difficulty check

  constructor(
    private readonly socket: Socket,
    firstChunk: Buffer,
    private readonly portConfig: StratumPortConfig,
    private readonly stratumV2Service: StratumV2Service,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly addressSettingsCacheService: AddressSettingsCacheService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    private readonly externalSharesService: ExternalSharesService,
    private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
    private readonly shareTotalsCacheService: ShareTotalsCacheService,
    private readonly extranonceManager?: Sv2ExtranonceManager,
    private readonly templateDistributionService?: TemplateDistributionService,
    private readonly pplnsService?: PplnsService,
    private readonly groupSoloService?: GroupSoloService,
    private readonly minerActiveModeService?: MinerActiveModeService,
    private readonly poolModeHashrateService?: PoolModeHashrateService,
  ) {
    this.sessionId = this.generateSessionId();
    this.sessionStart = new Date();
    const rawInitial = Number.isFinite(portConfig.initialDifficulty)
      ? portConfig.initialDifficulty
      : 16384;
    // Clamp initial difficulty to the port's floor (set on the PPLNS
    // port via PPLNS_MIN_DIFFICULTY) so a hash-rate-derived auto-target
    // can't dip below and let sub-500-GH/s miners pollute the ledger.
    const portMinDiff = portConfig.minimumDifficulty ?? 0;
    this.sessionDifficulty = portMinDiff > 0
      ? Math.max(rawInitial, portMinDiff)
      : rawInitial;
    this.debugMessages = process.env.SV2_DEBUG_MESSAGES === 'true';

    const networkConfig = this.configService.get('NETWORK');
    if (networkConfig === 'mainnet') {
      this.network = bitcoinjs.networks.bitcoin;
    } else if (networkConfig === 'testnet') {
      this.network = bitcoinjs.networks.testnet;
    } else if (networkConfig === 'regtest') {
      this.network = bitcoinjs.networks.regtest;
    } else {
      throw new Error('Invalid network configuration');
    }

    const parsed = parseInt(this.configService.get('DIFFICULTY_CHECK_INTERVAL_MS') ?? '60000');
    this.difficultyCheckIntervalMs = isNaN(parsed) ? 60000 : parsed;

    this.statistics = new StratumV1ClientStatistics(
      portConfig.targetSharesPerMinute,
      portMinDiff,
    );

    // Enable TCP_NODELAY to disable Nagle's algorithm (reduces latency)
    this.socket.setNoDelay(true);

    // Initialize Noise + plaintext framing
    this.noiseSession = new Sv2NoiseSession(this.stratumV2Service.getNoiseConfig());
    this.frameReader = new Sv2FrameReader(null);
    this.frameWriter = new Sv2FrameWriter(null);

    // Set timeout for V2 connections (5 min like V1)
    socket.setTimeout(1000 * 60 * 5);

    // Wire socket events
    socket.on('close', () => this.handleClose());
    socket.on('timeout', () => this.handleTimeout());
    socket.on('error', (err) => this.handleError(err));

    // Start handshake
    this.performHandshake(firstChunk).catch((err) => {
      console.error(`[SV2 ${this.sessionId}] Handshake failed:`, err.message);
      recordConnectionFailure(socket.remoteAddress);
      this.destroySocket();
    });
  }

  // ── Handshake ─────────────────────────────────────────────────────

  private async performHandshake(firstChunk: Buffer): Promise<void> {
    console.log(`[SV2 ${this.sessionId}] New connection from ${this.socket.remoteAddress}`);

    const debug = process.env.SV2_NOISE_DEBUG === 'true';
    const act1Chunk = firstChunk;

    if (debug) console.log(`[SV2 ${this.sessionId}] Standard SV2 miner (EllSwift DH mode)`);
    if (debug) console.log(`[SV2 ${this.sessionId}] First chunk (${firstChunk.length} bytes): ${firstChunk.subarray(0, Math.min(firstChunk.length, 20)).toString('hex')}...`);

    const expectedAct1Size = SV2_NOISE_ACT1_SIZE;

    if (act1Chunk.length < expectedAct1Size) {
      throw new Error(`First chunk too short for Act 1: ${act1Chunk.length} bytes (expected ${expectedAct1Size})`);
    }

    const act1 = act1Chunk.subarray(0, expectedAct1Size);
    const remainder = act1Chunk.subarray(expectedAct1Size);

    console.log(`[SV2 ${this.sessionId}] Noise Act 1 received (${act1.length} bytes)`);
    if (debug) console.log(`[SV2 ${this.sessionId}] Act 1 hex: ${act1.toString('hex')}`);

    // Process Act 1 -> produce Act 2
    if (debug) console.log(`[SV2 ${this.sessionId}] Processing Noise handshake...`);
    const act2 = await this.noiseSession.processAct1(act1);
    console.log(`[SV2 ${this.sessionId}] Noise Act 2 produced (${act2.length} bytes)`);
    if (debug) console.log(`[SV2 ${this.sessionId}] Act 2 hex: ${act2.toString('hex')}`);

    await this.writeRaw(act2);

    // Switch to encrypted framing
    this.frameReader.setDecryptFn(this.noiseSession.decrypt.bind(this.noiseSession));
    this.frameWriter.setEncryptFn(this.noiseSession.encrypt.bind(this.noiseSession));

    // Set up data listener for encrypted frames
    this.socket.on('data', (data: Buffer) => {
      if (this.destroyed) return;
      try {
        const frames = this.frameReader.feed(data);
        for (const frame of frames) {
          this.handleFrame(frame.header.msgType, frame.payload, frame.header.extensionType).catch((err) => {
            console.error(`[SV2 ${this.sessionId}] Frame handling error:`, err.message);
            this.destroySocket();
          });
        }
      } catch (err) {
        console.error(`[SV2 ${this.sessionId}] Frame read error:`, (err as Error).message);
        this.destroySocket();
      }
    });

    // Feed any bytes that arrived after the Act 1
    if (remainder.length > 0) {
      if (debug) console.log(`[SV2 ${this.sessionId}] Processing ${remainder.length} bytes received with Act 1`);
      const frames = this.frameReader.feed(remainder);
      for (const frame of frames) {
        await this.handleFrame(frame.header.msgType, frame.payload, frame.header.extensionType);
      }
    }

    console.log(`[SV2 ${this.sessionId}] Noise handshake complete, transport encrypted`);
    if (debug) console.log(`[SV2 ${this.sessionId}] ✅ Encrypted channel established, ready for SV2 protocol messages`);
  }

  // ── Frame Handling (dispatch by message type) ─────────────────────

  private async handleFrame(msgType: number, payload: Buffer, extensionType: number): Promise<void> {
    if (this.debugMessages) {
      const msgName = this.getMsgTypeName(msgType);
      console.log(`[SV2 ${this.sessionId}] 📨 RX: ${msgName} (0x${msgType.toString(16).padStart(2, '0')}) - ${payload.length} bytes`);
    }

    // Strip channel_msg bit (0x8000) to get the extension ID
    const extensionId = extensionType & 0x7FFF;

    // Extension 1: Extensions Negotiation (0x0001)
    // Spec: after SetupConnection.Success, client may send RequestExtensions before other messages.
    // We support no extensions, so respond with Success + empty supported list.
    if (extensionId === SV2_EXTENSION_NEGOTIATION_ID) {
      if (msgType === 0x00) {
        const reader = new BufferReader(payload);
        const msg = deserializeRequestExtensions(reader);
        console.log(`[SV2 ${this.sessionId}] RequestExtensions: requested=[${msg.requestedExtensions.map(e => `0x${e.toString(16)}`).join(', ')}]`);
        const responsePayload = serializeRequestExtensionsSuccess({ requestId: msg.requestId, supportedExtensions: [] });
        await this.sendFrameWithExtension(0x01, responsePayload, SV2_EXTENSION_NEGOTIATION_ID);
      } else {
        console.warn(`[SV2 ${this.sessionId}] Unknown Extension 1 msgType: 0x${msgType.toString(16)}, ignoring`);
      }
      return;
    }

    // Discard frames with unknown extension IDs (spec: MUST discard locally-processed unknown extensions)
    if (extensionId !== 0) {
      console.warn(`[SV2 ${this.sessionId}] Discarding frame with unknown extensionId=0x${extensionId.toString(16)}, msgType=0x${msgType.toString(16)}`);
      return;
    }

    switch (msgType) {
      case Sv2MsgType.SETUP_CONNECTION:
        await this.handleSetupConnection(payload);
        break;
      case Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL:
        await this.handleOpenChannel(payload);
        break;
      case Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL:
        await this.handleOpenExtendedChannel(payload);
        break;
      case Sv2MsgType.UPDATE_CHANNEL:
        await this.handleUpdateChannel(payload);
        break;
      case Sv2MsgType.CLOSE_CHANNEL:
        await this.handleCloseChannel(payload);
        break;
      case Sv2MsgType.SUBMIT_SHARES_STANDARD:
        await this.handleSubmitShares(payload);
        break;
      case Sv2MsgType.SUBMIT_SHARES_EXTENDED:
        await this.handleSubmitSharesExtended(payload);
        break;
      case Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS:
        await this.handleCoinbaseOutputConstraints(payload);
        break;
      case Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA:
        await this.handleRequestTransactionData(payload);
        break;
      case Sv2MsgType.TDP_SUBMIT_SOLUTION:
        await this.handleSubmitSolution(payload);
        break;
      case Sv2MsgType.SET_CUSTOM_MINING_JOB:
        await this.handleSetCustomMiningJob(payload);
        break;
      case Sv2MsgType.SET_CUSTOM_MINING_JOB_SUCCESS:
        console.log(`[SV2 ${this.sessionId}] Custom mining job acknowledged`);
        break;
      case Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR:
        console.warn(`[SV2 ${this.sessionId}] Custom mining job rejected by miner`);
        break;
      default:
        console.warn(`[SV2 ${this.sessionId}] Unknown message type: 0x${msgType.toString(16)}`);
        break;
    }
  }

  // ── SetupConnection (0x00) ────────────────────────────────────────

  private async handleSetupConnection(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeSetupConnection(reader);

    this.vendorInfo = msg.vendor;
    this.userAgent = `${msg.vendor}/sv2`;

    console.log(`[SV2 ${this.sessionId}] 📋 SetupConnection: protocol=${msg.protocol}, vendor=${msg.vendor}, firmware=${msg.firmwareVersion}, device=${msg.deviceId}, version=${msg.minVersion}-${msg.maxVersion}`);

    // Handle TDP client (protocol = 2)
    if (msg.protocol === Sv2Protocol.TEMPLATE_DISTRIBUTION) {
      this.isTdpClient = true;
      // Validate protocol version
      if (msg.minVersion > 2 || msg.maxVersion < 2) {
        const errorPayload = serializeSetupConnectionError({
          flags: msg.flags,
          errorCode: 'protocol-version-mismatch',
        });
        await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, errorPayload, 0);
        this.destroySocket();
        return;
      }
      const successPayload = serializeSetupConnectionSuccess({
        usedVersion: 2,
        flags: 0, // No mining flags for TDP
      });
      await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_SUCCESS, successPayload, 0);
      console.log(`[SV2 ${this.sessionId}] ✅ SetupConnectionSuccess (TDP): version=2, waiting for CoinbaseOutputConstraints`);
      return;
    }

    // Validate protocol version
    if (msg.minVersion > 2 || msg.maxVersion < 2) {
      console.error(`[SV2 ${this.sessionId}] ❌ Unsupported version range: ${msg.minVersion}-${msg.maxVersion} (pool requires v2)`);
      const errorPayload = serializeSetupConnectionError({
        flags: msg.flags,
        errorCode: 'protocol-version-mismatch',
      });
      await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, errorPayload, 0);
      this.destroySocket();
      return;
    }

    // Process client request flags (spec 5.3.1 SetupConnection.flags)
    const supportedFlags =
      Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS |
      Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION |
      Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING;
    const negotiatedFlags = msg.flags & supportedFlags;

    this.versionRollingEnabled = (negotiatedFlags & Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING) !== 0;
    this.workSelectionEnabled = (negotiatedFlags & Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION) !== 0;

    // Build response flags (spec 5.3.1 SetupConnection.Success.flags — different namespace)
    // Spec: "if REQUIRES_VERSION_ROLLING was set in SetupConnection::flags,
    // REQUIRES_FIXED_VERSION MUST NOT be set"
    let successFlags = 0;
    if (!this.versionRollingEnabled) {
      // Pool requires fixed version when client didn't request version rolling
      successFlags |= Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION;
    }

    const requestFlagsStr = [
      (negotiatedFlags & Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS) ? 'STANDARD_JOBS' : null,
      (negotiatedFlags & Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION) ? 'WORK_SELECTION' : null,
      (negotiatedFlags & Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING) ? 'VERSION_ROLLING' : null,
    ].filter(Boolean).join(', ');

    const successFlagsStr = [
      (successFlags & Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION) ? 'FIXED_VERSION' : null,
      (successFlags & Sv2MiningSetupSuccessFlags.REQUIRES_EXTENDED_CHANNELS) ? 'EXTENDED_CHANNELS' : null,
    ].filter(Boolean).join(', ');

    const successPayload = serializeSetupConnectionSuccess({
      usedVersion: 2,
      flags: successFlags,
    });
    await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_SUCCESS, successPayload, 0);

    console.log(`[SV2 ${this.sessionId}] ✅ SetupConnectionSuccess: version=2, requestFlags=[${requestFlagsStr}], successFlags=[${successFlagsStr}]`);
  }

  // ── OpenStandardMiningChannel (0x10) ──────────────────────────────

  private async handleOpenChannel(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeOpenStandardMiningChannel(reader);

    // Parse user_identity: "address.worker" or just "address"
    const parts = msg.user_identity.split('.');
    // Normalise bech32 (lowercase) at the entry point so every downstream
    // lookup (PPLNS window, group cache, ledger) keys on the canonical
    // form regardless of the case the miner happened to type.
    const rawAddress = normalizeBtcAddress(parts[0]);
    const workerName = parts.length > 1 ? parts.slice(1).join('.') : 'default';

    // Validate address
    try {
      getAddressInfo(rawAddress);
    } catch {
      console.warn(`[SV2 ${this.sessionId}] Invalid bitcoin address: ${rawAddress}`);
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'unknown-user',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      this.destroySocket();
      return;
    }

    // Multi-channel: subsequent channels must use same address
    if (this.address && this.address !== rawAddress) {
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'unknown-user',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }

    // Validate maxTarget (spec 5.3.6: server must accept target or respond with max-target-out-of-range)
    if (msg.maxTarget.every((b) => b === 0)) {
      console.warn(`[SV2 ${this.sessionId}] ❌ OpenStandardMiningChannel rejected: max-target-out-of-range (zero target)`);
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'max-target-out-of-range',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }

    // First channel sets connection-level state
    const isFirstChannel = this.channels.size === 0;
    if (isFirstChannel) {
      this.address = rawAddress;
      this.workerName = workerName;
    }

    const channelId = this.stratumV2Service.getNextChannelId();
    const extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix();

    // Compute initial difficulty from miner's reported hashrate (SV2 spec)
    // Falls back to portConfig.initialDifficulty if nominalHashRate is invalid
    let channelDifficulty = this.sessionDifficulty;
    if (Number.isFinite(msg.nominalHashRate) && msg.nominalHashRate > 0) {
      channelDifficulty = DifficultyUtils.hashRateToDifficulty(
        msg.nominalHashRate,
        this.portConfig.targetSharesPerMinute || 6,
      );
      if (!Number.isFinite(channelDifficulty) || channelDifficulty <= 0) {
        channelDifficulty = this.sessionDifficulty;
      }
    }
    // SV2 spec: server must not assign a target exceeding the client's declared maxTarget
    channelDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, msg.maxTarget);
    // Port floor (PPLNS_MIN_DIFFICULTY): prevent low-hashrate SV2 miners
    // from slipping under the floor via a tiny nominalHashRate. Always
    // spec-safe to raise assigned difficulty — a harder target is
    // strictly smaller than maxTarget, so the maxTarget constraint is
    // never violated. A miner whose hardware genuinely can't meet the
    // floor will simply see its shares rejected as difficulty-too-low
    // until it disconnects (same outcome SV1 already produces on this
    // port via the suggest_difficulty / nearestDifficultyStep floor).
    const portMinDiff = this.portConfig.minimumDifficulty ?? 0;
    if (portMinDiff > 0 && channelDifficulty < portMinDiff) {
      channelDifficulty = portMinDiff;
    }
    // Sanity ceiling. A misconfigured client (or attacker) sending a tiny
    // maxTarget forces clampDifficultyToMaxTarget into the e+50 range —
    // each subsequent rejected share then writes that absurd value into
    // the pool-shares Redis bucket, eventually overflowing the Postgres
    // `real` column (3.4e38) and freezing all pool-wide stats endpoints.
    // Refuse channels that would resolve to a difficulty no real miner
    // would ever legitimately need. See MAX_REASONABLE_DIFFICULTY for the
    // threshold rationale.
    if (channelDifficulty > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[SV2 ${this.sessionId}] ❌ OpenStandardMiningChannel rejected: max-target-out-of-range (computed difficulty ${channelDifficulty.toExponential(3)} exceeds ceiling ${MAX_REASONABLE_DIFFICULTY.toExponential(0)})`,
      );
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'max-target-out-of-range',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }
    // Update connection-level difficulty for vardiff baseline
    if (isFirstChannel) {
      this.sessionDifficulty = channelDifficulty;
    }

    // Create channel state
    const channelState: StratumV2ChannelState = {
      channelId,
      channelType: 'standard',
      extranoncePrefix,
      extranonceSize: 0,
      sessionDifficulty: channelDifficulty,
      jobIdToDifficulty: new Map(),
      extendedJobs: new Map(),
      latestExtendedPrevHash: Buffer.alloc(32),
      latestExtendedNBits: 0,
      latestExtendedMinNtime: 0,
      acceptedShareCount: 0,
      acceptedShareDifficultySum: 0n,
      acceptedShareDifficultyFloat: 0,
      miningSubmissionHashes: new Set(),
      declaredMaxTarget: msg.maxTarget,
    };
    this.channels.set(channelId, channelState);

    if (isFirstChannel) {
      this.primaryChannelId = channelId;

      // Register with service
      this.stratumV2Service.registerClient(this.address!, this);

      // Create DB entity
      await this.ensureEntity();

      this.notifyDeviceOnline();
    }

    // Send OpenStandardMiningChannelSuccess
    const target = DifficultyUtils.difficultyToTarget(channelState.sessionDifficulty);
    const successPayload = serializeOpenStandardMiningChannelSuccess({
      requestId: msg.requestId,
      channelId,
      target,
      extranonce_prefix: extranoncePrefix,
      groupChannelId: 0,
    });
    await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS, successPayload, 0);

    if (this.debugMessages) {
      console.log(`[SV2 ${this.sessionId}] ⛏️  OpenStandardChannel ${channelId}: address=${this.address}.${this.workerName}, nominalHashRate=${msg.nominalHashRate}, difficulty=${channelState.sessionDifficulty.toFixed(4)}, target=${target.toString('hex').substring(0, 16)}..., extranonce=${extranoncePrefix.toString('hex')}`);
    } else {
      console.log(`[SV2 ${this.sessionId}] ⛏️  OpenStandardChannel ${channelId}: address=${this.address}.${this.workerName}, nominalHashRate=${msg.nominalHashRate}, difficulty=${channelState.sessionDifficulty.toFixed(4)}`);
    }

    if (isFirstChannel) {
      // Send initial job + prevhash
      const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
      await this.sendNewMiningJob(jobTemplate, true, channelId);

      this.setupJobSubscriptionAndDifficultyInterval(false);
    } else {
      // For additional channels, send the latest job
      const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
      await this.sendNewMiningJob(jobTemplate, true, channelId);
    }
  }

  // ── OpenExtendedMiningChannel (0x13) ─────────────────────────────

  private async handleOpenExtendedChannel(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeOpenExtendedMiningChannel(reader);

    // Parse user_identity: "address.worker" or just "address"
    const parts = msg.userIdentity.split('.');
    // Normalise bech32 (lowercase) — see handleOpenChannel for rationale.
    const rawAddress = normalizeBtcAddress(parts[0]);
    const workerName = parts.length > 1 ? parts.slice(1).join('.') : 'default';

    // Validate address
    try {
      getAddressInfo(rawAddress);
    } catch {
      console.warn(`[SV2 ${this.sessionId}] Invalid bitcoin address: ${rawAddress}`);
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'unknown-user',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      this.destroySocket();
      return;
    }

    // Multi-channel: subsequent channels must use same address
    if (this.address && this.address !== rawAddress) {
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'unknown-user',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }

    // Validate maxTarget (spec 5.3.6: server must accept target or respond with max-target-out-of-range)
    if (msg.maxTarget.every((b) => b === 0)) {
      console.warn(`[SV2 ${this.sessionId}] ❌ OpenExtendedMiningChannel rejected: max-target-out-of-range (zero target)`);
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'max-target-out-of-range',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }

    const isFirstChannel = this.channels.size === 0;
    if (isFirstChannel) {
      this.address = rawAddress;
      this.workerName = workerName;
    }

    const channelId = this.stratumV2Service.getNextChannelId();

    // Allocate extranonce prefix via manager.
    let extranoncePrefix: Buffer;
    if (this.extranonceManager) {
      extranoncePrefix = this.extranonceManager.allocate(channelId);
    } else {
      extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix();
    }

    // SV2 spec (05-Mining-Protocol.md):
    // `extranonce_size` on the wire is the MINER's rollable portion ONLY —
    // it does NOT include the pool-assigned prefix. Full coinbase extranonce
    // = extranonce_prefix + extranonce(miner), total = prefix.length + extranonce_size.
    //
    // Store `channel.extranonceSize` as the rollable-only value to match wire
    // semantics and the SRI reference implementation (which calls the same
    // field `rollable_extranonce_size`). Total extranonce bytes is always
    // computed explicitly as `prefix.length + channel.extranonceSize`.
    //
    // Honor `min_extranonce_size` from the miner literally. SRI's reference
    // pool (pool-apps/pool) passes `msg.min_extranonce_size` directly to the
    // extranonce factory without upscaling to a pool-side default — if we
    // advertise a larger rollable size than the miner asked for, some
    // firmwares (Bitaxe, NerdQAxe) ignore our response and keep submitting
    // their originally-requested size, producing "Extranonce size mismatch"
    // warnings and suppressing block submission. Cap only at the upper end
    // (12 − prefixLength) so total coinbase extranonce stays ≤ 12 bytes.
    const defaultRollable = this.extranonceManager
      ? this.extranonceManager.minerExtranonceSize
      : Math.max(0, 12 - extranoncePrefix.length);
    const maxRollable = 12 - extranoncePrefix.length;
    const rollableExtranonceSize = msg.minExtranonceSize > 0
      ? Math.min(msg.minExtranonceSize, maxRollable)
      : defaultRollable;

    // Check if this is a JD client (has corresponding JDP connection)
    const isJdClient = this.stratumV2Service.hasJdpConnectionFromIp(this.getRemoteAddress());

    // Fix user agent and worker name for JD clients (they send empty vendor and no worker suffix)
    if (isJdClient) {
      if (!this.vendorInfo || this.vendorInfo.trim() === '') {
        this.userAgent = 'jd-client/sv2';
      }
      if (this.workerName === 'default') {
        this.workerName = 'jd-client';
      }
    }

    // Compute initial difficulty from miner's reported hashrate (SV2 spec)
    let channelDifficulty = this.sessionDifficulty;
    if (Number.isFinite(msg.nominalHashRate) && msg.nominalHashRate > 0) {
      channelDifficulty = DifficultyUtils.hashRateToDifficulty(
        msg.nominalHashRate,
        this.portConfig.targetSharesPerMinute || 6,
      );
      if (!Number.isFinite(channelDifficulty) || channelDifficulty <= 0) {
        channelDifficulty = this.sessionDifficulty;
      }
    }
    // SV2 spec: server must not assign a target exceeding the client's declared maxTarget
    channelDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, msg.maxTarget);
    // Port floor (see OpenStandardMiningChannel for rationale) — same
    // floor applies to the BitAxe / ESP-MINER extended-channel path.
    const extPortMinDiff = this.portConfig.minimumDifficulty ?? 0;
    if (extPortMinDiff > 0 && channelDifficulty < extPortMinDiff) {
      channelDifficulty = extPortMinDiff;
    }
    // Sanity ceiling — see handleOpenChannel for rationale.
    if (channelDifficulty > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[SV2 ${this.sessionId}] ❌ OpenExtendedMiningChannel rejected: max-target-out-of-range (computed difficulty ${channelDifficulty.toExponential(3)} exceeds ceiling ${MAX_REASONABLE_DIFFICULTY.toExponential(0)})`,
      );
      const errorPayload = serializeOpenMiningChannelError({
        requestId: msg.requestId,
        errorCode: 'max-target-out-of-range',
      });
      await this.sendFrame(Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR, errorPayload, 0);
      return;
    }
    if (isFirstChannel) {
      this.sessionDifficulty = channelDifficulty;
    }

    // Create channel state
    const channelState: StratumV2ChannelState = {
      channelId,
      channelType: 'extended',
      extranoncePrefix,
      extranonceSize: rollableExtranonceSize,
      sessionDifficulty: channelDifficulty,
      jobIdToDifficulty: new Map(),
      extendedJobs: new Map(),
      latestExtendedPrevHash: Buffer.alloc(32),
      latestExtendedNBits: 0,
      latestExtendedMinNtime: 0,
      acceptedShareCount: 0,
      acceptedShareDifficultySum: 0n,
      acceptedShareDifficultyFloat: 0,
      miningSubmissionHashes: new Set(),
      declaredMaxTarget: msg.maxTarget,
      isJdClient, // Mark JD client channels so we don't send pool jobs
    };
    this.channels.set(channelId, channelState);

    if (isFirstChannel) {
      this.primaryChannelId = channelId;

      // Register with service
      this.stratumV2Service.registerClient(this.address!, this);

      // Create DB entity
      await this.ensureEntity();

      this.notifyDeviceOnline();
    }

    // Send OpenExtendedMiningChannel.Success
    const target = DifficultyUtils.difficultyToTarget(channelState.sessionDifficulty);
    const successPayload = serializeOpenExtendedMiningChannelSuccess({
      requestId: msg.requestId,
      channelId,
      target,
      extranonceSize: rollableExtranonceSize,  // SV2 spec: miner-rollable portion only
      extranoncePrefix,
      groupChannelId: 0,
    });
    await this.sendFrame(Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS, successPayload, 0);

    const totalExtranonceBytes = extranoncePrefix.length + rollableExtranonceSize;
    console.log(`[SV2 ${this.sessionId}] 🔧 OpenExtendedChannel ${channelId}: address=${this.address}.${this.workerName}, nominalHashRate=${msg.nominalHashRate}, difficulty=${channelState.sessionDifficulty.toFixed(4)}, minExtranonceSize(requested)=${msg.minExtranonceSize}, extranonceSize(granted)=${rollableExtranonceSize}, prefix=${extranoncePrefix.length} bytes, total=${totalExtranonceBytes} bytes in coinbase, prefixHex=${extranoncePrefix.toString('hex')}`);

    if (isFirstChannel) {
      if (isJdClient || this.workSelectionEnabled) {
        console.log(`[SV2 ${this.sessionId}] 🔗 Work selection client detected - waiting for SetCustomMiningJob instead of sending pool jobs`);
        // Do NOT send NewExtendedMiningJob for work-selection clients (JDC)
        // They will declare their own custom jobs via JDP + SetCustomMiningJob

        this.setupJobSubscriptionAndDifficultyInterval(true);
        return;
      }

      // Send initial extended job (for non-work-selection clients)
      const initialJobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
      await this.sendNewExtendedMiningJobFromTemplate(true, initialJobTemplate, channelId);

      this.setupJobSubscriptionAndDifficultyInterval(true);
    } else {
      // For additional channels, send the latest job
      const initialJobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
      await this.sendNewExtendedMiningJobFromTemplate(true, initialJobTemplate, channelId);
    }
  }

  // ── UpdateChannel (0x16) ──────────────────────────────────────────

  private async handleUpdateChannel(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeUpdateChannel(reader);

    const channel = this.channels.get(msg.channelId);
    if (!channel) {
      const errorPayload = serializeUpdateChannelError({
        channelId: msg.channelId,
        errorCode: 'invalid-channel-id',
      });
      await this.sendFrame(Sv2MsgType.UPDATE_CHANNEL_ERROR, errorPayload, SV2_CHANNEL_MSG_FLAG);
      return;
    }

    // Update the channel's declared maxTarget (client may change it via UpdateChannel)
    channel.declaredMaxTarget = msg.maximumTarget;

    // Recalculate difficulty from updated nominalHashRate
    let newDifficulty = channel.sessionDifficulty;
    if (Number.isFinite(msg.nominalHashRate) && msg.nominalHashRate > 0) {
      newDifficulty = DifficultyUtils.hashRateToDifficulty(
        msg.nominalHashRate,
        this.portConfig.targetSharesPerMinute || 6,
      );
      if (!Number.isFinite(newDifficulty) || newDifficulty <= 0) {
        newDifficulty = channel.sessionDifficulty;
      }
    }
    // SV2 spec: server MUST reflect the maximum_target if smaller (harder) than current
    newDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(newDifficulty, msg.maximumTarget);
    // Port floor (see OpenStandardMiningChannel) — prevent a miner
    // from softening its maxTarget via UpdateChannel to drop below
    // PPLNS_MIN_DIFFICULTY after the channel was opened.
    const updatePortMinDiff = this.portConfig.minimumDifficulty ?? 0;
    if (updatePortMinDiff > 0 && newDifficulty < updatePortMinDiff) {
      newDifficulty = updatePortMinDiff;
    }
    // Sanity ceiling — refuse to apply an absurd difficulty via
    // UpdateChannel for the same reason we refuse it on OpenChannel.
    // Stick with the existing channel.sessionDifficulty rather than
    // closing the channel; the miner can either retry with a larger
    // maxTarget or live with their previously-assigned diff.
    if (newDifficulty > MAX_REASONABLE_DIFFICULTY) {
      console.warn(
        `[SV2 ${this.sessionId}] UpdateChannel ${msg.channelId} ignored: computed difficulty ${newDifficulty.toExponential(3)} exceeds ceiling ${MAX_REASONABLE_DIFFICULTY.toExponential(0)} (keeping ${channel.sessionDifficulty.toFixed(4)})`,
      );
      return;
    }

    const diffChanged = newDifficulty !== channel.sessionDifficulty;
    console.log(`[SV2 ${this.sessionId}] UpdateChannel ${msg.channelId} (nominalHashRate=${msg.nominalHashRate}, difficulty=${channel.sessionDifficulty.toFixed(4)} → ${newDifficulty.toFixed(4)}${diffChanged ? '' : ' (unchanged)'})`);

    if (diffChanged) {
      channel.sessionDifficulty = newDifficulty;

      // Send new target to the channel
      const target = DifficultyUtils.difficultyToTarget(newDifficulty);
      const targetPayload = serializeSetTarget({
        channelId: channel.channelId,
        maxTarget: target,
      });
      await this.sendFrame(Sv2MsgType.SET_TARGET, targetPayload, SV2_CHANNEL_MSG_FLAG);

      // Persist to DB
      if (this.entity) {
        try {
          await this.clientService.updateCurrentDifficulty(this.entity.sessionId, newDifficulty);
          this.entity.currentDifficulty = newDifficulty;
        } catch (err) {
          console.error('Failed to persist UpdateChannel difficulty', err);
        }
      }
    }
    // Per spec, success is implicit (no response message)
  }

  // ── CloseChannel (0x18) ──────────────────────────────────────────

  private async handleCloseChannel(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeCloseChannel(reader);

    const channel = this.channels.get(msg.channelId);
    if (!channel) {
      console.warn(`[SV2 ${this.sessionId}] CloseChannel for unknown channel ${msg.channelId}`);
      return;
    }

    console.log(`[SV2 ${this.sessionId}] CloseChannel ${msg.channelId}: ${msg.reasonCode}`);

    // Release extranonce prefix if extended channel
    if (this.extranonceManager && channel.channelType === 'extended') {
      this.extranonceManager.release(channel.channelId);
    }

    // Remove channel
    this.channels.delete(msg.channelId);

    // Update primary channel ID if needed
    if (this.primaryChannelId === msg.channelId) {
      const remaining = this.channels.keys().next();
      this.primaryChannelId = remaining.done ? null : remaining.value;
    }

    // Do NOT close the socket when channels.size === 0.
    //
    // SV2 spec §5.3.9: "The server MUST stop sending messages for the
    // channel." That's it — no requirement to tear down the connection.
    // Channel lifecycle is independent from connection lifecycle: a
    // single SV2 connection (one SetupConnection handshake) is designed
    // to host many open/close cycles of mining channels over time.
    //
    // Forcing a socket close here was a spec violation that broke
    // tProxy in non-aggregated mode: when an SV1 miner attached to
    // tProxy disconnects, tProxy correctly forwards CloseChannel
    // upstream; if that was the last channel for that miner the
    // pool used to drop the entire upstream connection, forcing
    // tProxy through a fresh Noise handshake + SetupConnection
    // before the next SV1 miner could connect.
    //
    // Reported by stratum-mining/sv2-ui#143. The connection now
    // stays alive on an empty channel set; the client decides when
    // to disconnect (TCP close, idle timeout on its side, or pool
    // sending close-on-error). Resource cleanup for the closed
    // channel itself (extranonce release above) already happened.
    //
    // BUT: with no channels left, there is nothing to broadcast to,
    // so RELEASE the job subscription and the difficulty timer.
    // Without this, the next OpenExtendedMiningChannel from the
    // surviving connection would call `setupJobSubscriptionAndDifficultyInterval`
    // again — and (pre this fix) leak a second subscription on top
    // of the existing one. Each subscription dispatches its own
    // NewExtendedMiningJob with a fresh jobId on every block, which
    // is exactly the symptom reported in sv2-ui#143 follow-up:
    // "Blitzpool sent three NewExtendedMiningJob for identical
    // template, then SetNewPrevHash referencing older job_ids,
    // tProxy fallback on JobIdNotFound". Releasing here keeps the
    // setup path idempotent across open/close cycles.
    if (this.channels.size === 0) {
      if (this.stratumSubscription) {
        this.stratumSubscription.unsubscribe();
        this.stratumSubscription = null;
      }
      if (this.difficultyCheckInterval) {
        clearInterval(this.difficultyCheckInterval);
        this.difficultyCheckInterval = null;
      }
    }
  }

  // ── CoinbaseOutputConstraints (0x70) ──────────────────────────────

  private async handleCoinbaseOutputConstraints(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeTdpCoinbaseOutputConstraints(reader);
    this.coinbaseOutputMaxAdditionalSize = msg.coinbaseOutputMaxAdditionalSize;
    console.log(`[SV2 ${this.sessionId}] CoinbaseOutputConstraints: size=${this.coinbaseOutputMaxAdditionalSize}, sigops=${msg.coinbaseOutputMaxAdditionalSigops}`);

    if (!this.isTdpClient || !this.templateDistributionService) return;

    // Send the latest template + prevHash immediately (matched pair by templateId)
    const latest = this.templateDistributionService.getLatestTemplate();
    if (latest) {
      await this.sendTdpNewTemplate(latest.template);
      await this.sendTdpSetNewPrevHash(latest.prevHash);
    }

    // Subscribe to future templates and prevhashes (skip first replay from ReplaySubject)
    const templateSub = this.templateDistributionService.newTemplate$.pipe(skip(1)).subscribe(async (template) => {
      try {
        await this.sendTdpNewTemplate(template);
      } catch (e) {
        console.error(`[SV2 ${this.sessionId}] TDP template send error:`, (e as Error).message);
        this.destroySocket();
      }
    });

    const prevHashSub = this.templateDistributionService.newPrevHash$.pipe(skip(1)).subscribe(async (prevHash) => {
      try {
        await this.sendTdpSetNewPrevHash(prevHash);
      } catch (e) {
        console.error(`[SV2 ${this.sessionId}] TDP prevhash send error:`, (e as Error).message);
        this.destroySocket();
      }
    });

    this.tdpSubscriptions.push(templateSub, prevHashSub);
    console.log(`[SV2 ${this.sessionId}] ✅ TDP streaming started`);
  }

  // ── TDP Send Helpers ───────────────────────────────────────────────

  private async sendTdpNewTemplate(template: Sv2TdpNewTemplate): Promise<void> {
    // Spec §7.3: server MUST send at least one NewTemplate with future_template=true before every
    // SetNewPrevHash. Since we always pair NewTemplate + SetNewPrevHash for clearJobs=true jobs,
    // we always force future_template=true. The TDP client caches it and activates via SetNewPrevHash.
    const toSend = template.futureTemplate ? template : { ...template, futureTemplate: true };
    const payload = serializeTdpNewTemplate(toSend);
    await this.sendFrame(Sv2MsgType.TDP_NEW_TEMPLATE, payload, 0);
    console.log(`[SV2 ${this.sessionId}] 📋 TDP → NewTemplate: id=${template.templateId}, future=true, merklePath=${template.merklePath.length}`);
  }

  private async sendTdpSetNewPrevHash(prevHash: Sv2TdpSetNewPrevHash): Promise<void> {
    const payload = serializeTdpSetNewPrevHash(prevHash);
    await this.sendFrame(Sv2MsgType.TDP_SET_NEW_PREV_HASH, payload, 0);
    console.log(`[SV2 ${this.sessionId}] 🔗 TDP → SetNewPrevHash: templateId=${prevHash.templateId}, nBits=0x${prevHash.nBits.toString(16)}`);
  }

  // ── RequestTransactionData (0x73) ─────────────────────────────────

  private async handleRequestTransactionData(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeTdpRequestTransactionData(reader);

    if (!this.templateDistributionService) {
      const errorPayload = serializeTdpRequestTransactionDataError({
        templateId: msg.templateId,
        errorCode: 'template-id-not-found',
      });
      await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR, errorPayload, 0);
      return;
    }

    const stored = this.templateDistributionService.getTemplate(msg.templateId);
    if (!stored) {
      const errorPayload = serializeTdpRequestTransactionDataError({
        templateId: msg.templateId,
        errorCode: 'template-id-not-found',
      });
      await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR, errorPayload, 0);
      return;
    }

    // Spec §7.6: if the template is in memory but its prev_hash no longer points to the
    // latest tip, return stale-template-id (distinct from template-id-not-found).
    const latestTemplate = this.templateDistributionService.getLatestTemplate();
    if (latestTemplate && !stored.prevHash.prevHash.equals(latestTemplate.prevHash.prevHash)) {
      const errorPayload = serializeTdpRequestTransactionDataError({
        templateId: msg.templateId,
        errorCode: 'stale-template-id',
      });
      await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR, errorPayload, 0);
      console.log(`[SV2 ${this.sessionId}] RequestTransactionData: stale template ${msg.templateId}`);
      return;
    }

    // Serialize transactions from the stored template's job template
    const transactions = stored.jobTemplate.block.transactions || [];
    const transactionList: Buffer[] = [];
    // Skip coinbase (index 0), send remaining transactions
    for (let i = 1; i < transactions.length; i++) {
      const tx = transactions[i];
      // @ts-ignore
      const serialized = tx.__toBuffer ? tx.__toBuffer() : (tx.toBuffer ? tx.toBuffer() : Buffer.alloc(0));
      if (serialized.length > 0) {
        transactionList.push(serialized);
      }
    }

    const successPayload = serializeTdpRequestTransactionDataSuccess({
      templateId: msg.templateId,
      excessData: Buffer.alloc(0),
      transactionList,
    });
    await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_SUCCESS, successPayload, 0);

    console.log(`[SV2 ${this.sessionId}] RequestTransactionData: sent ${transactionList.length} transactions for template ${msg.templateId}`);
  }

  // ── Broadcast jobs to all channels ────────────────────────────────

  private async broadcastNewJobToAllChannels(jobTemplate: IJobTemplate, clearJobs: boolean): Promise<void> {
    // Skip all channels if this is a work-selection client (JDC manages its own jobs)
    if (this.workSelectionEnabled) return;

    for (const channel of this.channels.values()) {
      // Skip JD client channels - they manage their own jobs via Job Declaration Protocol
      // Dynamic check: JDP connection may arrive after the mining channel was opened
      if (!channel.isJdClient && this.stratumV2Service.hasJdpConnectionFromIp(this.getRemoteAddress())) {
        channel.isJdClient = true;
        // Late JDP detection — fix userAgent and workerName
        if (!this.vendorInfo || this.vendorInfo.trim() === '') {
          this.userAgent = 'jd-client/sv2';
        }
        if (this.workerName === 'default') {
          this.workerName = 'jd-client';
        }
        // Update DB entity with corrected userAgent
        if (this.entity) {
          this.clientService.updateUserAgent(this.entity.sessionId, this.userAgent).catch(() => {});
        }
      }
      if (channel.isJdClient) {
        continue;
      }

      if (channel.channelType === 'standard') {
        await this.sendNewMiningJob(jobTemplate, clearJobs, channel.channelId);
      } else {
        await this.sendNewExtendedMiningJobFromTemplate(clearJobs, jobTemplate, channel.channelId);
      }
    }
  }

  // ── Send Extended Mining Job ────────────────────────────────────

  private async sendNewExtendedMiningJobFromTemplate(sendPrevHash: boolean, jobTemplate: IJobTemplate, channelId?: number): Promise<void> {
    const targetChannelId = channelId ?? this.primaryChannelId;
    if (targetChannelId == null) return;
    const channel = this.channels.get(targetChannelId);
    if (!channel) return;

    // Skip sending jobs to JD client channels - they manage their own jobs
    if (channel.isJdClient) {
      return;
    }

    // Get template data from TDP service if available
    if (this.templateDistributionService) {
      const stored = this.templateDistributionService.getLatestTemplate();
      if (stored) {
        // Build payout information and create a proper MiningJob with real coinbase outputs.
        // K4: drop the sync fallback — async returns null only when the miner is on a
        // PPLNS or group-solo port with an empty window, which must skip the job
        // (not silently produce a solo coinbase). Solo path is reached inside async.
        const payoutInformation = await this.buildPayoutInformationAsync(stored.jobTemplate.blockData.coinbasevalue);
        if (!payoutInformation) return;

        const jobIdStr = this.stratumV1JobsService.getNextId();
        const jobId = parseInt(jobIdStr, 16);
        const job = new MiningJob(
          this.configService,
          this.network,
          jobIdStr,
          payoutInformation,
          stored.jobTemplate,
        );
        this.stratumV1JobsService.addJob(job);

        // Extract non-witness coinbase prefix/suffix from MiningJob
        // Patch the scriptSig length varint if this channel's total extranonce
        // size (prefix + rollable) != 12 bytes (the default MiningJob assumes:
        // 4 enonce1 + 8 enonce2, sized for Braiins Hashpower marketplace ≥7).
        const totalExtranonceBytes = (channel.extranoncePrefix?.length ?? 0) + channel.extranonceSize;
        const coinbasePrefix = patchCoinbasePrefixVarint(job.getCoinbasePrefixBuffer(), totalExtranonceBytes);
        const coinbaseSuffix = job.getCoinbaseSuffixBuffer();

        const jobPayload = serializeNewExtendedMiningJob({
          channelId: targetChannelId,
          jobId,
          minNtime: sendPrevHash ? null : stored.prevHash.headerTimestamp,
          version: stored.template.version,
          versionRollingAllowed: this.versionRollingEnabled,
          merklePath: stored.template.merklePath,
          coinbasePrefix,
          coinbaseSuffix,
        });
        await this.sendFrame(Sv2MsgType.NEW_EXTENDED_MINING_JOB, jobPayload, SV2_CHANNEL_MSG_FLAG);

        // Store job-specific difficulty (SV2 spec: shares validated against target from when job was sent)
        channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);

        console.log(`[SV2 ${this.sessionId}] 📨 NewExtendedMiningJob: channel=${targetChannelId}, jobId=${jobId}, height=${jobTemplate.blockData.height}, version=0x${stored.template.version.toString(16)}, merklePathLen=${stored.template.merklePath.length}, prefixLen=${coinbasePrefix.length}, suffixLen=${coinbaseSuffix.length}, futureJob=${sendPrevHash}`);

        // Store extended job data for share validation
        const prevHash = sendPrevHash ? stored.prevHash.prevHash : channel.latestExtendedPrevHash;
        const nBits = sendPrevHash ? stored.prevHash.nBits : channel.latestExtendedNBits;
        const minNtime = sendPrevHash ? stored.prevHash.headerTimestamp : channel.latestExtendedMinNtime;

        channel.extendedJobs.set(jobId, {
          coinbasePrefix,
          coinbaseSuffix,
          merklePath: stored.template.merklePath,
          version: stored.template.version,
          prevHash,
          nBits,
          minNtime,
          jobTemplate,
          miningJob: job,
          creation: Date.now(),
        });

        if (sendPrevHash) {
          channel.latestExtendedPrevHash = stored.prevHash.prevHash;
          channel.latestExtendedNBits = stored.prevHash.nBits;
          channel.latestExtendedMinNtime = stored.prevHash.headerTimestamp;

          const prevHashPayload = serializeSetNewPrevHash({
            channelId: targetChannelId,
            jobId,
            prevHash: stored.prevHash.prevHash,
            minNtime: stored.prevHash.headerTimestamp,
            nBits: stored.prevHash.nBits,
          });
          await this.sendFrame(Sv2MsgType.SET_NEW_PREV_HASH, prevHashPayload, SV2_CHANNEL_MSG_FLAG);

          console.log(`[SV2 ${this.sessionId}] 🔗 SetNewPrevHash (Extended): channel=${targetChannelId}, jobId=${jobId}, height=${jobTemplate.blockData.height}, prevHash=${stored.prevHash.prevHash.toString('hex').substring(0, 16)}..., nBits=0x${stored.prevHash.nBits.toString(16)}`);
        }
        return;
      }
    }

    // Fallback: use job template directly (build merkle path from merkle_branch)
    await this.sendExtendedMiningJobFromJobTemplate(jobTemplate, sendPrevHash, targetChannelId);
  }

  private async sendExtendedMiningJobFromJobTemplate(jobTemplate: IJobTemplate, sendPrevHash: boolean, channelId: number): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    // Skip sending jobs to JD client channels - they manage their own jobs
    if (channel.isJdClient) {
      return;
    }

    // Build payout information and create a proper MiningJob with real coinbase outputs.
    // K4: see buildPayoutInformationAsync — async-only contract, no sync fallback.
    const payoutInformation = await this.buildPayoutInformationAsync(jobTemplate.blockData.coinbasevalue);
    if (!payoutInformation) return;

    const jobIdStr = this.stratumV1JobsService.getNextId();
    const jobId = parseInt(jobIdStr, 16);
    const job = new MiningJob(
      this.configService,
      this.network,
      jobIdStr,
      payoutInformation,
      jobTemplate,
    );
    this.stratumV1JobsService.addJob(job);

    // Build merkle path from merkle_branch
    const merklePath = merkleBranchToBuffers(jobTemplate.merkle_branch);

    // Extract non-witness coinbase prefix/suffix from MiningJob
    // Patch the scriptSig length varint if this channel's total extranonce
    // size (prefix + rollable) != 12 bytes (the default MiningJob assumes:
    // 4 enonce1 + 8 enonce2, sized for Braiins Hashpower marketplace ≥7).
    const totalExtranonceBytes = (channel.extranoncePrefix?.length ?? 0) + channel.extranonceSize;
    const coinbasePrefix = patchCoinbasePrefixVarint(job.getCoinbasePrefixBuffer(), totalExtranonceBytes);
    const coinbaseSuffix = job.getCoinbaseSuffixBuffer();

    const jobPayload = serializeNewExtendedMiningJob({
      channelId,
      jobId,
      minNtime: sendPrevHash ? null : jobTemplate.block.timestamp,
      version: jobTemplate.block.version,
      versionRollingAllowed: this.versionRollingEnabled,
      merklePath,
      coinbasePrefix,
      coinbaseSuffix,
    });
    await this.sendFrame(Sv2MsgType.NEW_EXTENDED_MINING_JOB, jobPayload, SV2_CHANNEL_MSG_FLAG);

    // Store job-specific difficulty (SV2 spec: shares validated against target from when job was sent)
    channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);

    // Store extended job data for share validation
    const prevHash = sendPrevHash
      ? (jobTemplate.block.prevHash ? Buffer.from(jobTemplate.block.prevHash) : Buffer.alloc(32))
      : channel.latestExtendedPrevHash;
    const nBits = sendPrevHash ? jobTemplate.block.bits : channel.latestExtendedNBits;
    const minNtime = sendPrevHash ? jobTemplate.block.timestamp : channel.latestExtendedMinNtime;

    channel.extendedJobs.set(jobId, {
      coinbasePrefix,
      coinbaseSuffix,
      merklePath,
      version: jobTemplate.block.version,
      prevHash,
      nBits,
      minNtime,
      jobTemplate,
      miningJob: job,
      creation: Date.now(),
    });

    if (sendPrevHash) {
      channel.latestExtendedPrevHash = prevHash;
      channel.latestExtendedNBits = nBits;
      channel.latestExtendedMinNtime = minNtime;

      const prevHashPayload = serializeSetNewPrevHash({
        channelId,
        jobId,
        prevHash,
        minNtime: jobTemplate.block.timestamp,
        nBits: jobTemplate.block.bits,
      });
      await this.sendFrame(Sv2MsgType.SET_NEW_PREV_HASH, prevHashPayload, SV2_CHANNEL_MSG_FLAG);
    }
  }

  // ── Extended Share Submission (0x1b) ────────────────────────────

  private async handleSubmitSharesExtended(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const submission = deserializeSubmitSharesExtended(reader);

    if (this.debugMessages) console.log(`[SV2 ${this.sessionId}] 📤 SubmitSharesExtended: channel=${submission.channelId}, jobId=${submission.jobId}, nonce=0x${submission.nonce.toString(16).padStart(8, '0')}, extranonce=${submission.extranonce.toString('hex')}`);

    // Look up channel
    const channel = this.channels.get(submission.channelId);
    if (!channel) {
      console.warn(`[SV2 ${this.sessionId}] ❌ Extended share rejected: invalid-channel-id ${submission.channelId}`);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
      return;
    }

    // Ensure entity exists
    await this.ensureEntity();

    // Look up job-specific difficulty (needed for error reporting)
    const jobDifficulty = channel.jobIdToDifficulty.get(submission.jobId) ?? channel.sessionDifficulty;

    // Duplicate check (include extranonce in the hash)
    const submissionHash = this.computeExtendedShareHash(submission);
    if (channel.miningSubmissionHashes.has(submissionHash)) {
      console.warn(`[SV2 ${this.sessionId}] ❌ Extended share rejected: stale-share`);
      await this.recordRejectedShare('DuplicateShare', jobDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
      return;
    }
    channel.miningSubmissionHashes.add(submissionHash);
    if (channel.miningSubmissionHashes.size > 10000) channel.miningSubmissionHashes.clear();

    // Look up extended job data by job ID. SV2 spec §5.3.14 distinguishes
    // `invalid-job-id` (genuinely unknown) from `stale-share` (was known,
    // since superseded). Pre-fix the channel's extendedJobs got wiped on
    // every block change BEFORE the new job was broadcast, so any in-flight
    // share resolved to `null` here and got the wrong code (`invalid-job-id`
    // instead of `stale-share`).
    const extJob = channel.extendedJobs.get(submission.jobId);
    if (!extJob) {
      console.warn(`[SV2 ${this.sessionId}] ❌ Extended share rejected: invalid-job-id (jobId=${submission.jobId})`);
      await this.recordRejectedShare('JobNotFound', jobDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
      return;
    }

    // Classify against retirement state. A retired-but-known job emits the
    // proper SV2 wire code `stale-share` (NOT `invalid-job-id`) and a
    // distinct internal `Stale` rejection counter. Within STALE_GRACE_MS
    // of retirement we accept the share as-if-current (network jitter
    // absorption) — it falls through to the normal validation path below.
    const extClassification = this.classifyExtendedJobForShare(extJob);
    if (extClassification === 'stale-rejected') {
      console.warn(`[SV2 ${this.sessionId}] ❌ Extended share rejected: stale-share (jobId=${submission.jobId}, retired ${Date.now() - (extJob.retiredAt ?? 0)}ms ago)`);
      await this.recordRejectedShare('Stale', jobDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
      return;
    }

    // Validate extranonce size — the miner must send exactly the negotiated
    // size. `channel.extranonceSize` IS the wire value (miner-rollable bytes,
    // same as `rollable_extranonce_size` in the SRI reference), so the
    // submitted extranonce length must equal it directly — no prefix math.
    // Mismatch means malformed coinbase varint, skip block submission.
    const expectedMinerExtranonceSize = channel.extranonceSize;
    const extranonceValid = submission.extranonce.length === expectedMinerExtranonceSize;
    if (!extranonceValid) {
      console.warn(`[SV2 ${this.sessionId}] ⚠️  Extranonce size mismatch: got=${submission.extranonce.length}, expected=${expectedMinerExtranonceSize} (block submission will be skipped)`);
    } else if (!channel.firstShareLogged) {
      channel.firstShareLogged = true;
      console.log(`[SV2 ${this.sessionId}] ✅ First extended share: extranonce length ok, got=${submission.extranonce.length} bytes (matches negotiated ${expectedMinerExtranonceSize})`);
    }

    // 1. Reconstruct coinbase transaction (non-witness serialization)
    const coinbaseTxBytes = Buffer.concat([
      extJob.coinbasePrefix,
      channel.extranoncePrefix || Buffer.alloc(0),
      submission.extranonce,
      extJob.coinbaseSuffix,
    ]);

    // 2. Compute coinbase txid (double SHA-256 of non-witness serialization)
    const coinbaseTxid = bitcoinjs.crypto.hash256(coinbaseTxBytes);

    // 3. Walk merkle path to compute merkle root
    let merkleRoot = Buffer.from(coinbaseTxid);
    const bothHashes = Buffer.alloc(64);
    for (const sibling of extJob.merklePath) {
      bothHashes.set(merkleRoot, 0);
      bothHashes.set(sibling, 32);
      merkleRoot = bitcoinjs.crypto.hash256(bothHashes);
    }

    // 4. Build 80-byte block header
    const header = Buffer.alloc(80);
    header.writeInt32LE(submission.version, 0);
    extJob.prevHash.copy(header, 4);
    merkleRoot.copy(header, 36);
    header.writeUInt32LE(submission.ntime, 68);
    header.writeUInt32LE(extJob.nBits, 72);
    header.writeUInt32LE(submission.nonce, 76);

    // 5. Calculate difficulty (for logging + block-detection only)
    const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);

    if (this.debugMessages) console.log(`[SV2 ${this.sessionId}] 🎯 Extended share difficulty: ${submissionDifficulty.toFixed(2)} (target: ${jobDifficulty.toFixed(2)})`);

    // Exact accept/reject via direct hash≤target compare — see meetsTarget().
    const jobTarget = DifficultyUtils.difficultyToTarget(jobDifficulty);
    if (DifficultyUtils.meetsTarget(hashBuffer, jobTarget)) {
      // Only reconstruct full block when the share actually meets network difficulty
      let updatedJobBlock: bitcoinjs.Block | null = null;
      const networkDifficulty = extJob.jobTemplate?.blockData.networkDifficulty;
      if (extranonceValid && extJob.jobTemplate && networkDifficulty != null && submissionDifficulty >= networkDifficulty) {
        try {
          updatedJobBlock = this.reconstructExtendedBlock(extJob, submission, merkleRoot, channel.extranoncePrefix);
        } catch (e) {
          console.error(`[SV2 ${this.sessionId}] Block reconstruction failed:`, (e as Error).message);
        }
      }

      await this.handleValidShare(submission, submissionDifficulty, extJob.jobTemplate, updatedJobBlock, header, channel, jobDifficulty);
    } else {
      console.warn(`[SV2 ${this.sessionId}] ❌ Extended share rejected: difficulty-too-low (${submissionDifficulty.toFixed(2)} < ${jobDifficulty.toFixed(2)})`);
      await this.recordRejectedShare('LowDifficultyShare', jobDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
    }
  }

  /**
   * Reconstruct a full bitcoinjs.Block from extended job data + miner submission.
   * Used for block submission when a block-difficulty share is found.
   *
   * Deep-clones the MiningJob's coinbase transaction (which has proper payout
   * outputs, witness commitment, and block height) then patches the scriptSig
   * with the actual extranonce (prefix + miner portion). This mirrors how the
   * V1 path works in MiningJob.copyAndUpdateBlock().
   */
  private reconstructExtendedBlock(
    extJob: ExtendedJobData,
    submission: Sv2SubmitSharesExtended,
    merkleRoot: Buffer,
    extranoncePrefix: Buffer,
  ): bitcoinjs.Block {
    const jobTemplate = extJob.jobTemplate!;
    const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
    testBlock.transactions = jobTemplate.block.transactions.map(tx =>
      Object.assign(new bitcoinjs.Transaction(), tx)
    );

    // Deep-clone the MiningJob's coinbase (has proper outputs, witness, block height).
    // The MiningJob's scriptSig ends with a 12-byte extranonce slot (4 prefix + 8 miner-controlled, all zeros).
    // Replace it with the actual extranonce (pool prefix + miner portion).
    const coinbaseTx = extJob.miningJob!.cloneCoinbaseTransaction();
    const originalScript = coinbaseTx.ins[0].script;
    coinbaseTx.ins[0].script = Buffer.concat([
      originalScript.subarray(0, originalScript.length - 12),
      extranoncePrefix || Buffer.alloc(0),
      submission.extranonce,
    ]);

    testBlock.transactions[0] = coinbaseTx;

    // Set header fields from miner submission
    testBlock.version = submission.version;
    testBlock.nonce = submission.nonce;
    testBlock.timestamp = submission.ntime;
    testBlock.merkleRoot = merkleRoot;

    return testBlock;
  }

  private computeExtendedShareHash(submission: Sv2SubmitSharesExtended): string {
    return `${submission.jobId}:${submission.nonce}:${submission.ntime}:${submission.version}:${submission.extranonce.toString('hex')}`;
  }

  private async handleValidShare(
    submission: { channelId: number; sequenceNumber: number },
    submissionDifficulty: number,
    jobTemplate: IJobTemplate | null,
    updatedJobBlock: bitcoinjs.Block | null,
    header: Buffer,
    channel: StratumV2ChannelState,
    jobDifficulty: number,
    isStaleCreditable: boolean = false,
  ): Promise<void> {
    // Send success response immediately for minimum latency
    // SV2 spec: new_submits_accepted_count / new_shares_sum are per-batch, not cumulative
    channel.acceptedShareCount++;
    channel.acceptedShareDifficultyFloat += jobDifficulty;
    channel.acceptedShareDifficultySum = BigInt(Math.round(channel.acceptedShareDifficultyFloat));
    const successPayload = serializeSubmitSharesSuccess({
      channelId: submission.channelId,
      lastSequenceNumber: submission.sequenceNumber,
      newSubmitsAcceptedCount: 1,
      newSharesSum: BigInt(Math.round(jobDifficulty)),
    });
    this.sendFrame(Sv2MsgType.SUBMIT_SHARES_SUCCESS, successPayload, SV2_CHANNEL_MSG_FLAG).catch(err =>
      console.error(`[SV2 ${this.sessionId}] Failed to send share success:`, err)
    );
    if (this.debugMessages) console.log(`[SV2 ${this.sessionId}] ✅ Extended share accepted: seq=${submission.sequenceNumber}, totalAccepted=${channel.acceptedShareCount}, totalDiff=${channel.acceptedShareDifficultySum.toString()}`);

    // Accounting and block submission below — all fully awaited, nothing skipped
    await this.poolShareStatisticsService.addAcceptedShare(jobDifficulty);

    // ckpool-style: a possible block-solve is ALWAYS submitted to bitcoind,
    // even from the stale-creditable path (stratifier.c:6191-6195 "Make
    // sure we always submit any possible block solve" — a stale-creditable
    // hit during a reorg could still be a valid alternative tip). bitcoind
    // authoritatively decides validity. Block-bookkeeping (`blocksService`,
    // push notification, PPLNS/group-solo `onBlockFound`) is gated on
    // `result === 'SUCCESS!'` so a rejected block leaves no artefact.
    // The `isStaleCreditable` parameter is kept for future
    // instrumentation / metrics distinguishing block-attempts from
    // stale vs active jobs, but does NOT short-circuit submission.
    void isStaleCreditable;
    if (jobTemplate && updatedJobBlock && submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
      console.log(`[SV2 ${this.sessionId}] 🎉🎉🎉 BLOCK FOUND (Extended)!!! Height: ${jobTemplate.blockData.height}, Difficulty: ${submissionDifficulty.toFixed(2)}`);
      const blockHex = updatedJobBlock.toHex(false);
      const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);

      if (result !== 'SUCCESS!') {
        // bitcoind rejected (bad-prevblk for a stale tip, duplicate from
        // a race, or RPC error). Skip all bookkeeping. The share itself
        // already got work-credit above; only block-level state is gated.
        console.warn(`[SV2 ${this.sessionId}] Block submit rejected at height ${jobTemplate.blockData.height}: ${result}`);
      } else {
        await this.blocksService.save({
          height: jobTemplate.blockData.height,
          minerAddress: this.address!,
          worker: this.workerName,
          sessionId: this.entity!.sessionId,
          blockData: blockHex,
        });

        await this.notificationService.notifySubscribersBlockFound(
          this.address!,
          jobTemplate.blockData.height,
          updatedJobBlock,
          result,
        );

        await this.addressSettingsService.resetBestDifficultyAndShares();
        await this.addressSettingsCacheService.clear();

        // Routing priority: explicit PPLNS port trumps group membership.
        // Mirror of StratumV1Client — bewusster Port-Wahl des Miners schlägt
        // die Default-Address-Driven-Group-Routing.
        const foundGroupId = this.activeGroupId();
        if (this.portConfig.payoutMode === 'pplns' && this.pplnsService?.isEnabled() && jobTemplate) {
          await this.pplnsService.onBlockFound(
            jobTemplate.blockData.height,
            jobTemplate.blockData.coinbasevalue,
          );
        } else if (foundGroupId && jobTemplate) {
          await this.groupSoloService!.onBlockFound(
            jobTemplate.blockData.height,
            jobTemplate.blockData.coinbasevalue,
            this.address!,
          );
        }
      }
    }

    try {
      this.statistics.updateHashRate(jobDifficulty);
      this.hashRate = this.statistics.hashRate;
      await this.clientStatisticsService.addAcceptedShare(this.entity!, jobDifficulty);

      // Record share — PPLNS port overrides group membership, matching
      // the coinbase-build + block-found routing above. After the routing
      // decision, write a Redis port-marker so /api/pplns/mode/:address
      // reflects the port the miner is ACTUALLY on right now. 5-min TTL,
      // refreshed every share.
      // PPLNS warmup gate (see StratumV1Client for rationale). Only
      // applies to the PPLNS port; group-solo / solo always record.
      this.acceptedShareCount++;
      const shareGroupId = this.activeGroupId();
      const warmupThreshold = this.portConfig.ledgerWarmupShares ?? 0;
      let effectiveMode: 'solo' | 'pplns' | 'group-solo';
      if (this.portConfig.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
        if (this.acceptedShareCount > warmupThreshold) {
          await this.pplnsService.recordShare(this.address!, jobDifficulty);
        }
        effectiveMode = 'pplns';
      } else if (shareGroupId) {
        await this.groupSoloService!.recordShare(this.address!, jobDifficulty);
        effectiveMode = 'group-solo';
      } else {
        effectiveMode = 'solo';
      }
      if (this.address) {
        await this.minerActiveModeService?.mark(this.address, effectiveMode);
        await this.poolModeHashrateService?.incrementAccepted(effectiveMode, jobDifficulty);
      }

      this.shareTotalsCacheService.increment(
        this.address!,
        this.workerName,
        jobDifficulty,
      );

      const now = new Date();
      if (!this.entity!.updatedAt || now.getTime() - this.entity!.updatedAt.getTime() > 60000) {
        await this.clientService.heartbeat(
          this.entity!.address,
          this.entity!.clientName,
          this.entity!.sessionId,
          this.hashRate,
          now,
          jobDifficulty,
        );
        this.entity!.updatedAt = now;
      }

      await this.clientDifficultyStatisticsService.recordShareDifficulty({
        address: this.address!,
        clientName: this.workerName,
        timestamp: now.getTime(),
        difficulty: submissionDifficulty,
      });

      if (now.getTime() - this.lastDifficultyCheck >= this.difficultyCheckIntervalMs) {
        if (channel.isJdClient) {
          await this.checkJdClientDifficulty(submissionDifficulty);
        } else {
          await this.checkDifficultyAllChannels();
        }
      }
    } catch (e) {
      console.error(`[SV2 ${this.sessionId}] Share accounting error:`, e);
    }

    if (submissionDifficulty > this.entity!.bestDifficulty) {
      await this.clientService.updateBestDifficulty(this.entity!.sessionId, submissionDifficulty);
      this.entity!.bestDifficulty = submissionDifficulty;
    }

    const shouldUpdateBestDifficulty = await this.addressSettingsCacheService.shouldUpdateBestDifficulty(
      this.address!,
      submissionDifficulty,
    );
    if (shouldUpdateBestDifficulty) {
      await this.notificationService.notifySubscribersBestDiff(this.address!, submissionDifficulty);
      await this.addressSettingsService.updateBestDifficulty(this.address!, submissionDifficulty, this.entity!.userAgent);
      await this.addressSettingsCacheService.updateBestDifficulty(
        this.address!,
        submissionDifficulty,
        this.entity!.userAgent ?? null,
      );
    }

    // External share submission
    const externalEnabled = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() === 'true';
    const minDifficulty = parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) || 1000000000000.0;
    if (externalEnabled && submissionDifficulty >= minDifficulty) {
      this.externalSharesService.submitShare({
        worker: this.workerName,
        address: this.address!,
        userAgent: this.userAgent,
        header: header.toString('hex'),
        externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool',
      });
    }
  }

  // ── SubmitSolution (0x76) — TDP block submission ─────────────────

  private async handleSubmitSolution(payload: Buffer): Promise<void> {
    if (!this.templateDistributionService) {
      console.warn(`[SV2 ${this.sessionId}] SubmitSolution received but no TDP service available`);
      return;
    }

    const reader = new BufferReader(payload);
    const solution = deserializeTdpSubmitSolution(reader);

    console.log(`[SV2 ${this.sessionId}] SubmitSolution received (templateId=${solution.templateId})`);

    const response = await this.templateDistributionService.handleSubmitSolution(solution);

    // String return means early error (template-not-found, invalid-coinbase)
    if (typeof response === 'string') {
      console.warn(`[SV2 ${this.sessionId}] SubmitSolution: rejected (${response})`);
      return;
    }

    const { result, blockHex, height, coinbasevalue } = response;

    // Gate ALL block-bookkeeping on bitcoind acceptance. Previously
    // `blocksService.save` and the push notification ran unconditionally,
    // which meant any rejection (bad-prevblk on a stale solve, duplicate
    // from a race, RPC error) wrote a phantom row and pushed a "block
    // found" notification to subscribers. Aligns with the V1 + SV2
    // standard channel paths (and ckpool's `out_submit` semantics:
    // submit always, record only on success).
    if (result !== 'SUCCESS!') {
      console.warn(`[SV2 ${this.sessionId}] SubmitSolution: rejected (${result}) — height ${height} bookkeeping skipped`);
      return;
    }

    await this.ensureEntity();
    await this.blocksService.save({
      height,
      minerAddress: this.address!,
      worker: this.workerName,
      sessionId: this.entity!.sessionId,
      blockData: blockHex,
    });
    await this.notificationService.notifySubscribersBlockFound(
      this.address!,
      height,
      null,
      result,
    );

    console.log(`[SV2 ${this.sessionId}] SubmitSolution: block accepted by network!`);
    await this.addressSettingsService.resetBestDifficultyAndShares();
    await this.addressSettingsCacheService.clear();

    // K5: TDP block submission was missing the PPLNS / group-solo
    // onBlockFound dispatch. Without this, a TDP-path miner that
    // finds a block while on the PPLNS port (or in an active
    // group) gets the block accepted on-chain but no payout
    // snapshot is taken — the round / window is never reset and
    // no one is credited. Mirror of the extended-channel routing
    // (PPLNS port > group-membership > solo).
    const foundGroupId = this.activeGroupId();
    if (this.portConfig.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
      await this.pplnsService.onBlockFound(height, coinbasevalue);
    } else if (foundGroupId) {
      await this.groupSoloService!.onBlockFound(height, coinbasevalue, this.address!);
    }
  }

  // ── SetCustomMiningJob (0x22) - FROM JD Client ────────────────────

  private async handleSetCustomMiningJob(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeSetCustomMiningJob(reader);

    console.log(`[SV2 ${this.sessionId}] 📋 SetCustomMiningJob received: channel=${msg.channelId}, requestId=${msg.requestId}, token=${msg.token.toString('hex').substring(0, 16)}...`);

    // Validate channel exists
    const channel = this.channels.get(msg.channelId);
    if (!channel) {
      console.warn(`[SV2 ${this.sessionId}] SetCustomMiningJob for unknown channel ${msg.channelId}`);
      const errorPayload = serializeSetCustomMiningJobError({
        channelId: msg.channelId,
        requestId: msg.requestId,
        errorCode: 'invalid-channel-id',
      });
      await this.sendFrame(Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR, errorPayload, 0);
      return;
    }

    // Reconstruct full coinbase_tx_prefix and coinbase_tx_suffix from SetCustomMiningJob fields.
    // SetCustomMiningJob provides raw coinbase fields (scriptSig prefix, outputs, etc.),
    // but share validation (line ~1152) expects NewExtendedMiningJob-style prefix/suffix:
    // the full non-witness serialized coinbase transaction split at the extranonce position.
    //
    // Non-witness coinbase layout:
    //   [tx_version:4] [input_count:varint] [null_outpoint:36] [script_sig_len:varint]
    //   [coinbase_prefix] [EXTRANONCE] [sequence:4] [outputs_with_count] [locktime:4]
    //                     ^-- split here

    // Total extranonce bytes = pool prefix + miner-rollable portion.
    // `channel.extranonceSize` is the rollable-only value, matching SV2 spec.
    const fullExtranonceSize = (channel.extranoncePrefix?.length ?? 0) + channel.extranonceSize;
    const scriptSigLen = msg.coinbasePrefix.length + fullExtranonceSize;

    // Encode script_sig length as Bitcoin varint
    let scriptSigLenVarint: Buffer;
    if (scriptSigLen < 0xFD) {
      scriptSigLenVarint = Buffer.from([scriptSigLen]);
    } else if (scriptSigLen <= 0xFFFF) {
      scriptSigLenVarint = Buffer.alloc(3);
      scriptSigLenVarint[0] = 0xFD;
      scriptSigLenVarint.writeUInt16LE(scriptSigLen, 1);
    } else {
      scriptSigLenVarint = Buffer.alloc(5);
      scriptSigLenVarint[0] = 0xFE;
      scriptSigLenVarint.writeUInt32LE(scriptSigLen, 1);
    }

    // tx_version (4 bytes LE)
    const txVersion = Buffer.alloc(4);
    txVersion.writeUInt32LE(msg.coinbaseTxVersion, 0);

    // Null outpoint: 32 zero bytes (hash) + 0xFFFFFFFF (index)
    const nullOutpoint = Buffer.alloc(36);
    nullOutpoint.fill(0x00, 0, 32);
    nullOutpoint.writeUInt32LE(0xFFFFFFFF, 32);

    // coinbase_tx_prefix = everything before the extranonce in non-witness serialization
    const coinbasePrefix = Buffer.concat([
      txVersion,              // 4 bytes
      Buffer.from([0x01]),    // input count = 1 (varint)
      nullOutpoint,           // 36 bytes (null hash + 0xFFFFFFFF index)
      scriptSigLenVarint,     // 1-3 bytes
      msg.coinbasePrefix,     // scriptSig prefix bytes
    ]);

    // sequence (4 bytes LE)
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(msg.coinbaseTxInputNSequence, 0);

    // locktime (4 bytes LE)
    const locktime = Buffer.alloc(4);
    locktime.writeUInt32LE(msg.coinbaseTxLocktime, 0);

    // coinbase_tx_suffix = everything after the extranonce in non-witness serialization
    const coinbaseSuffix = Buffer.concat([
      sequence,               // 4 bytes
      msg.coinbaseTxOutputs,  // includes output count varint + serialized outputs
      locktime,               // 4 bytes
    ]);

    // Store custom job in extended channel for share validation
    const jobId = this.nextCustomJobId;
    this.nextCustomJobId = this.nextCustomJobId >= 0xFFFFFFFF ? 1 : this.nextCustomJobId + 1;
    channel.extendedJobs.set(jobId, {
      coinbasePrefix,
      coinbaseSuffix,
      merklePath: Array.from(msg.merklePath),
      version: msg.version,
      prevHash: msg.prevHash,
      nBits: msg.nBits,
      minNtime: msg.minNtime,
      jobTemplate: null, // Custom job, no template reference
      creation: Date.now(),
    });

    console.log(`[SV2 ${this.sessionId}] ✅ SetCustomMiningJob accepted: assigned jobId=${jobId}, version=0x${msg.version.toString(16)}, merklePathLen=${msg.merklePath.length}`);

    // Respond with success
    const successPayload = serializeSetCustomMiningJobSuccess({
      channelId: msg.channelId,
      requestId: msg.requestId,
      jobId,
    });
    await this.sendFrame(Sv2MsgType.SET_CUSTOM_MINING_JOB_SUCCESS, successPayload, 0);
  }

  // ── Send Mining Job ───────────────────────────────────────────────

  /**
   * Solo-only payout builder. After K4 this is reached only via
   * `buildPayoutInformationAsync` for the genuine solo path (not on a
   * PPLNS port, not in an active group). External callers must use
   * the async variant — it owns the PPLNS / group-solo branches and
   * the empty-window skip semantics.
   */
  private buildPayoutInformation(): { address: string; percent: number }[] | null {
    if (this.entity && this.address) {
      this.hashRate = this.statistics.hashRate;
    }

    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
    const devFeePercent = parseFloat(this.configService.get('DEV_FEE_PERCENT') ?? '1.5');

    if (!this.address) {
      if (!devFeeAddress) return null;
      this.noFee = false;
      return [{ address: devFeeAddress, percent: 100 }];
    }

    this.noFee = !devFeeAddress || devFeeAddress.length < 1;
    if (this.noFee) {
      return [{ address: this.address, percent: 100 }];
    }
    return [
      { address: devFeeAddress, percent: devFeePercent },
      { address: this.address, percent: 100 - devFeePercent },
    ];
  }

  private async buildPayoutInformationAsync(blockRewardSats: number): Promise<{ address: string; percent: number }[] | null> {
    // PPLNS port overrides group membership — a miner who connected
    // to the PPLNS port opted out of group-solo for this session.
    if (this.portConfig.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
      const distribution = await this.pplnsService.getPayoutDistribution(blockRewardSats);
      if (distribution && distribution.length > 0) {
        this.noFee = false;
        return distribution;
      }
      // K4: empty PPLNS window — skip the job. The previous behavior
      // fell through to buildPayoutInformation() (sync, no blockReward
      // arg → sync guard didn't fire → solo coinbase). That silently
      // paid the lone miner 100 % on a port he opted into PPLNS for.
      // Only realistic at pool cold-start or post-Redis-flush; once
      // any share lands the window is no longer empty and the next
      // job builds a real PPLNS distribution.
      console.warn(
        `[StratumV2Client] PPLNS window empty — skipping job for ${this.address ?? '<unauth>'}, ` +
        `will retry on next template`,
      );
      return null;
    }
    const asyncGroupId = this.activeGroupId();
    if (asyncGroupId) {
      // Per-miner coinbase: pass this session's address as finderAddress
      // so the group's finder-bonus (if any) lands as a dedicated coinbase
      // output to whoever this template is being mined by. Same flow for
      // standard and extended channels — both reach this path via
      // buildPayoutInformationAsync.
      const distribution = await this.groupSoloService!.getPayoutDistribution(
        asyncGroupId,
        blockRewardSats,
        this.address,
      );
      if (distribution && distribution.length > 0) {
        this.noFee = false;
        return distribution;
      }
      // Group-solo equivalent of the K4 PPLNS empty-window case. A
      // group with no shares this round has no distribution to build
      // — fall-through to solo would skim the round's first block
      // for the lone miner. Skip instead; round will fill on the
      // next share.
      console.warn(
        `[StratumV2Client] group-solo round empty for group ${asyncGroupId} — ` +
        `skipping job for ${this.address ?? '<unauth>'}`,
      );
      return null;
    }
    return this.buildPayoutInformation();
  }

  /**
   * Live lookup of the active group-id for this session's address. Returns null
   * if group-solo isn't enabled, no address is set yet, or the address isn't in
   * an active group. Called per-share/per-job because membership can change
   * after channel-open (miner added to group while connected).
   */
  private activeGroupId(): string | null {
    if (!this.groupSoloService?.isEnabled()) return null;
    if (!this.address) return null;
    const entry = this.groupSoloService.getGroupForAddress(this.address);
    return entry?.active ? entry.groupId : null;
  }

  private async sendNewMiningJob(jobTemplate: IJobTemplate, sendPrevHash: boolean, channelId?: number): Promise<void> {
    const targetChannelId = channelId ?? this.primaryChannelId;
    if (targetChannelId == null) return;
    const channel = this.channels.get(targetChannelId);
    if (!channel) return;

    // K4: see buildPayoutInformationAsync — async-only contract, no sync fallback.
    const payoutInformation = await this.buildPayoutInformationAsync(jobTemplate.blockData.coinbasevalue);
    if (!payoutInformation) return;

    const job = new MiningJob(
      this.configService,
      this.network,
      this.stratumV1JobsService.getNextId(),
      payoutInformation,
      jobTemplate,
    );

    this.stratumV1JobsService.addJob(job);

    // Build SV2 NewMiningJob message
    // For standard channels, the merkle root MUST include the channel's extranonce prefix.
    // The miner receives this fixed merkle root and builds headers from it directly.
    // We compute it by patching the extranonce into the coinbase and recomputing the root.
    const extraNonce1 = channel.extranoncePrefix.toString('hex');
    // 8-byte zero-fill (16 hex chars) to match MiningJob's 12-byte coinbase slot
    // (4-byte enonce1 + 8-byte enonce2). Standard channels don't put anything
    // user-controlled here — only the channel's prefix differentiates merkle roots.
    const extraNonce2 = '0000000000000000';
    // Only the merkle root is needed for NewMiningJob — `computeShareMerkleRoot`
    // skips the full Block allocation that `copyAndUpdateBlock` would do.
    const merkleRoot = job.computeShareMerkleRoot(jobTemplate, extraNonce1, extraNonce2);

    const jobPayload = serializeNewMiningJob({
      channelId: targetChannelId,
      jobId: parseInt(job.jobId, 16),
      minNtime: sendPrevHash ? null : jobTemplate.block.timestamp, // Sv2Option<u32>: null = future job (activated by SetNewPrevHash), Some(ts) = mine immediately
      version: jobTemplate.block.version,
      merkleRoot,
    });
    // NewMiningJob carries channel_msg=1 per SRI reference impl
    // (`CHANNEL_BIT_NEW_MINING_JOB = true`). The sv2-spec §8 table
    // erroneously lists it as channel_msg=0 — same class of doc-bug
    // we already documented for PushSolution. BraiinsOS / bosminer
    // follow SRI strictly and reject channel_msg=0 frames as
    // "Unknown message type", which is what was breaking Standard-
    // channel Braiins miners. Payload is byte-identical either way
    // (channel_id is already the first field), so the change is
    // purely the routing bit in the frame header.
    await this.sendFrame(Sv2MsgType.NEW_MINING_JOB, jobPayload, SV2_CHANNEL_MSG_FLAG);

    // Store job-specific difficulty (SV2 spec: shares validated against target from when job was sent)
    channel.jobIdToDifficulty.set(parseInt(job.jobId, 16), channel.sessionDifficulty);

    if (this.debugMessages) {
      console.log(`[SV2 ${this.sessionId}] 📨 NewMiningJob: channel=${targetChannelId}, jobId=0x${job.jobId}, height=${jobTemplate.blockData.height}, version=0x${jobTemplate.block.version.toString(16)}, futureJob=${!sendPrevHash}, merkleRoot=${merkleRoot.toString('hex').substring(0, 16)}...`);
    }

    // Send SetNewPrevHash if clearing jobs (new block)
    if (sendPrevHash) {
      const prevHash = jobTemplate.block.prevHash
        ? Buffer.from(jobTemplate.block.prevHash)
        : Buffer.alloc(32);

      const prevHashPayload = serializeSetNewPrevHash({
        channelId: targetChannelId,
        jobId: parseInt(job.jobId, 16),
        prevHash,
        minNtime: jobTemplate.block.timestamp,
        nBits: jobTemplate.block.bits,
      });
      await this.sendFrame(Sv2MsgType.SET_NEW_PREV_HASH, prevHashPayload, SV2_CHANNEL_MSG_FLAG);

      if (this.debugMessages) {
        console.log(`[SV2 ${this.sessionId}] 🔗 SetNewPrevHash: channel=${targetChannelId}, jobId=0x${job.jobId}, height=${jobTemplate.blockData.height}, prevHash=${prevHash.toString('hex').substring(0, 16)}..., nBits=0x${jobTemplate.block.bits.toString(16)}, minNtime=${jobTemplate.block.timestamp}`);
      }
    }
  }

  // ── Share Submission (0x1a) ───────────────────────────────────────

  private async handleSubmitShares(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const submission = deserializeSubmitSharesStandard(reader);

    if (this.debugMessages) console.log(`[SV2 ${this.sessionId}] 📤 SubmitSharesStandard: channel=${submission.channelId}, jobId=0x${submission.jobId.toString(16)}, nonce=0x${submission.nonce.toString(16).padStart(8, '0')}, version=0x${submission.version.toString(16).padStart(8, '0')}`);

    // Look up channel
    const channel = this.channels.get(submission.channelId);
    if (!channel) {
      console.warn(`[SV2 ${this.sessionId}] ❌ Share rejected: invalid-channel-id ${submission.channelId}`);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
      return;
    }

    // Ensure entity exists
    await this.ensureEntity();

    // Duplicate check
    const submissionHash = this.computeShareHash(submission);
    if (channel.miningSubmissionHashes.has(submissionHash)) {
      console.warn(`[SV2 ${this.sessionId}] ❌ Share rejected: stale-share`);
      await this.recordRejectedShare('DuplicateShare', channel.sessionDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
      return;
    }
    channel.miningSubmissionHashes.add(submissionHash);
    if (channel.miningSubmissionHashes.size > 10000) channel.miningSubmissionHashes.clear();

    // Lookup job. Genuine miss = JobNotFound (job was GC'd after 10min);
    // found-but-retired-beyond-grace = stale (separate counter, see
    // classifyJobForShare in stratum-v1-jobs.service for the lifecycle).
    const jobIdHex = submission.jobId.toString(16);
    const job = this.stratumV1JobsService.getJobById(jobIdHex);
    if (!job) {
      await this.recordRejectedShare('JobNotFound', channel.sessionDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
      return;
    }

    const classification = this.stratumV1JobsService.classifyJobForShare(job);
    if (classification === 'stale-rejected') {
      await this.recordRejectedShare('Stale', channel.sessionDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
      return;
    }

    const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);
    if (!jobTemplate) {
      await this.recordRejectedShare('JobNotFound', channel.sessionDifficulty);
      delete this.stratumV1JobsService.jobs[jobIdHex];
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
      return;
    }

    // Reconstruct block
    // versionMask = submitted version XOR base version
    const versionMask = submission.version ^ jobTemplate.block.version;
    const extraNonce1 = channel.extranoncePrefix.toString('hex');
    // Zero-pad extraNonce2 to fill remaining extranonce space (12-byte slot:
    // 4-byte prefix + 8-byte enonce2). Must match the value used in
    // sendNewMiningJob to produce the same merkleRoot for share validation.
    const extraNonce2 = '0000000000000000';

    // Hot path: only compute the 80-byte header for hash validation.
    // Full Block (for `bitcoind.submitblock`) is built below ONLY if the
    // share actually meets network difficulty — same pattern the SV2
    // Extended path (~line 1515) has used since inception. Saves the
    // ~3000-tx clone in MiningJob.copyAndUpdateBlock per share.
    const header = job.computeShareHeader(
      jobTemplate,
      versionMask,
      submission.nonce,
      extraNonce1,
      extraNonce2,
      submission.ntime,
    );
    const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);

    // Look up job-specific difficulty (SV2 spec: validate against target from when job was sent)
    const jobDifficulty = channel.jobIdToDifficulty.get(submission.jobId) ?? channel.sessionDifficulty;

    if (this.debugMessages) console.log(`[SV2 ${this.sessionId}] 🎯 Share difficulty: ${submissionDifficulty.toFixed(2)} (target: ${jobDifficulty.toFixed(2)})`);

    // Exact accept/reject via direct hash≤target compare — see meetsTarget().
    const jobTarget = DifficultyUtils.difficultyToTarget(jobDifficulty);
    if (DifficultyUtils.meetsTarget(hashBuffer, jobTarget)) {
      // Build full Block lazily, only when we have a block-finder.
      let updatedJobBlock: bitcoinjs.Block | null = null;
      if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
        updatedJobBlock = job.copyAndUpdateBlock(
          jobTemplate, versionMask, submission.nonce, extraNonce1, extraNonce2, submission.ntime,
        );
      }
      await this.handleValidShare(
        submission,
        submissionDifficulty,
        jobTemplate,
        updatedJobBlock,
        header,
        channel,
        jobDifficulty,
        classification === 'stale-creditable',
      );
    } else {
      // Low difficulty
      console.warn(`[SV2 ${this.sessionId}] ❌ Share rejected: difficulty-too-low (${submissionDifficulty.toFixed(2)} < ${jobDifficulty.toFixed(2)})`);
      await this.recordRejectedShare('LowDifficultyShare', jobDifficulty);
      await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
    }
  }

  // ── Difficulty Adjustment ─────────────────────────────────────────

  private async checkDifficultyAllChannels(): Promise<void> {
    this.lastDifficultyCheck = Date.now();
    const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
    if (targetDiff == null || !Number.isFinite(targetDiff)) return;

    if (targetDiff !== this.sessionDifficulty) {
      this.sessionDifficulty = targetDiff;

      if (this.entity) {
        try {
          await this.clientService.updateCurrentDifficulty(this.entity.sessionId, targetDiff);
          this.entity.currentDifficulty = targetDiff;
        } catch (err) {
          console.error('Failed to persist current difficulty', err);
        }
      }

      // Send SetTarget to all channels (clamped per-channel against declared maxTarget)
      for (const channel of this.channels.values()) {
        const clampedDiff = DifficultyUtils.clampDifficultyToMaxTarget(targetDiff, channel.declaredMaxTarget);
        channel.sessionDifficulty = clampedDiff;
        const target = DifficultyUtils.difficultyToTarget(clampedDiff);
        const targetPayload = serializeSetTarget({
          channelId: channel.channelId,
          maxTarget: target,
        });
        await this.sendFrame(Sv2MsgType.SET_TARGET, targetPayload, SV2_CHANNEL_MSG_FLAG);

        if (this.debugMessages) {
          console.log(`[SV2 ${this.sessionId}] 🎯 SetTarget: channel=${channel.channelId}, difficulty=${clampedDiff.toFixed(4)}, target=${target.toString('hex').substring(0, 16)}...`);
        }
      }

      // Send new job with clearJobs after difficulty change
      if (this.channels.size > 0) {
        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
        jobTemplate.blockData.clearJobs = true;
        await this.broadcastNewJobToAllChannels(jobTemplate, true);
      }
    }
  }

  // ── JD-Client Difficulty Adjustment ──────────────────────────────
  //
  // Standard vardiff (getSuggestedDifficulty) doesn't work for JD clients because
  // they pre-filter shares at their own downstream difficulty. The pool sees shares
  // arriving at a rate determined by the JD client's difficulty, not the pool's target.
  // So standard vardiff never adjusts up.
  //
  // Instead, we count shares per interval and adjust the pool target to hit
  // targetSharesPerMinute, just like vardiff but using share count directly.

  private async checkJdClientDifficulty(latestSubmissionDifficulty: number): Promise<void> {
    this.lastDifficultyCheck = Date.now();

    const channel = this.primaryChannelId != null ? this.channels.get(this.primaryChannelId) : undefined;
    if (!channel) return;

    const sharesThisInterval = channel.acceptedShareCount - this.jdShareCountAtLastCheck;
    this.jdShareCountAtLastCheck = channel.acceptedShareCount;

    // Need at least a few shares to make a decision
    if (sharesThisInterval < 2) return;

    const intervalSeconds = this.difficultyCheckIntervalMs / 1000;
    const sharesPerMinute = (sharesThisInterval / intervalSeconds) * 60;
    const targetSpm = this.portConfig.targetSharesPerMinute || 6;

    // Compute ideal difficulty: current_diff * (actual_spm / target_spm)
    const ratio = sharesPerMinute / targetSpm;
    if (!Number.isFinite(ratio) || ratio <= 0) return;

    // Only adjust if significantly off (more than 2x in either direction)
    if (ratio < 2 && ratio > 0.5) return;

    let newDiff = channel.sessionDifficulty * ratio;

    // Also ensure pool target doesn't exceed what the JD client actually submits
    // (cap at the latest actual share difficulty to avoid over-shooting)
    newDiff = Math.min(newDiff, latestSubmissionDifficulty);

    // Round to nearest power-of-2 step
    if (newDiff <= 0) return;
    const exponent = Math.floor(Math.log2(newDiff));
    const lower = 2 ** exponent;
    const middle = lower + lower / 2;
    const upper = lower * 2;
    const candidates = [lower, middle, upper];
    candidates.sort((a, b) => Math.abs(newDiff - a) - Math.abs(newDiff - b));
    const targetDiff = candidates[0];

    if (targetDiff === channel.sessionDifficulty || !Number.isFinite(targetDiff)) return;

    console.log(`[SV2 ${this.sessionId}] 🔧 JD-client difficulty adjust: ${channel.sessionDifficulty.toFixed(2)} → ${targetDiff.toFixed(2)} (${sharesPerMinute.toFixed(1)} spm, target ${targetSpm} spm)`);

    this.sessionDifficulty = targetDiff;
    for (const ch of this.channels.values()) {
      ch.sessionDifficulty = targetDiff;
    }

    if (this.entity) {
      try {
        await this.clientService.updateCurrentDifficulty(this.entity.sessionId, targetDiff);
        this.entity.currentDifficulty = targetDiff;
      } catch (err) {
        console.error('Failed to persist JD-client difficulty', err);
      }
    }

    // Send SetTarget to all channels (clamped per-channel against declared maxTarget)
    for (const ch of this.channels.values()) {
      const clampedDiff = DifficultyUtils.clampDifficultyToMaxTarget(targetDiff, ch.declaredMaxTarget);
      ch.sessionDifficulty = clampedDiff;
      const jdTarget = DifficultyUtils.difficultyToTarget(clampedDiff);
      const targetPayload = serializeSetTarget({
        channelId: ch.channelId,
        maxTarget: jdTarget,
      });
      await this.sendFrame(Sv2MsgType.SET_TARGET, targetPayload, SV2_CHANNEL_MSG_FLAG);
    }
  }

  // ── Helper: record rejected shares ────────────────────────────────

  private async recordRejectedShare(errorType: string, difficulty?: number): Promise<void> {
    const diff = difficulty ?? this.sessionDifficulty;
    await this.poolRejectedStatisticsService.addRejectedShare(errorType, diff);
    await this.poolShareStatisticsService.addRejectedShare(diff);
    if (this.address) {
      await this.clientRejectedStatisticsService.addRejectedShare(
        this.address,
        errorType,
        diff,
      );
    }
    if (this.entity) {
      await this.clientStatisticsService.addRejectedShare(
        this.entity,
        errorType,
        diff,
      );
    }
    // Group-solo reject counter. Skipped when the miner is on the PPLNS
    // port — that's an explicit opt-out from group bookkeeping for this
    // session, so inflating the group's reject counter from these sessions
    // would be wrong.
    if (this.portConfig.payoutMode !== 'pplns') {
      const rejGroupId = this.activeGroupId();
      if (rejGroupId && this.address) {
        await this.groupSoloService!.recordReject(this.address, diff);
      }
    }
  }

  private async sendShareError(channelId: number, sequenceNumber: number, errorCode: string): Promise<void> {
    const errorPayload = serializeSubmitSharesError({
      channelId,
      sequenceNumber,
      errorCode,
    });
    // Fire-and-forget for minimum latency
    this.sendFrame(Sv2MsgType.SUBMIT_SHARES_ERROR, errorPayload, SV2_CHANNEL_MSG_FLAG).catch(err =>
      console.error(`[SV2 ${this.sessionId}] Failed to send share error:`, err)
    );
  }

  // ── Job Subscription & Difficulty Interval ──────────────────────

  private setupJobSubscriptionAndDifficultyInterval(clearExtendedJobs: boolean): void {
    // Defensive cleanup: tProxy in non-aggregated mode opens a fresh
    // extended channel for every SV1 miner that attaches. Each first-
    // channel-open flow lands on this method (`isFirstChannel = true` once
    // the previous channels closed), and without my CloseChannel fix
    // (f19c0cb) the connection died in between. With that fix the
    // connection now survives, but THIS method just overwrote the
    // `stratumSubscription` field without unsubscribing the previous
    // handle — leaking subscriptions per SV1-miner-cycle. The leaked
    // subscriptions all received `newMiningJob$` emissions and each
    // dispatched its own NewExtendedMiningJob with a fresh jobId, which
    // is exactly the symptom GitGab19 reported in sv2-ui#143
    // (3 future jobs sent for the same template, then SetNewPrevHash
    // referencing the older ones, tProxy fallback on JobIdNotFound).
    //
    // Same leak for `difficultyCheckInterval` — old timers continued to
    // fire in addition to the new one. Both must be released here.
    if (this.stratumSubscription) {
      this.stratumSubscription.unsubscribe();
      this.stratumSubscription = null;
    }
    if (this.difficultyCheckInterval) {
      clearInterval(this.difficultyCheckInterval);
      this.difficultyCheckInterval = null;
    }

    this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe(async (jt) => {
      try {
        if (jt.blockData.clearJobs) {
          // Per-channel race fix, mirrors the central jobs-service refactor.
          // Pre-fix: `extendedJobs.clear()` ran synchronously BEFORE the new
          // job got broadcast — for the few ms between clear and broadcast,
          // any in-flight share against the old jobId resolved to `null` in
          // `channel.extendedJobs.get()` and got rejected as
          // `invalid-job-id`. Per SV2 spec §5.3.14 a share against a
          // superseded but still-known job should be `stale-share`,
          // distinct from `invalid-job-id`.
          //
          // New behaviour: stamp `retiredAt` on every existing extended job;
          // keep them queryable until they age out via
          // `cleanupRetiredExtendedJobs()`. Share validation classifies
          // active vs stale-creditable vs stale-rejected against this
          // retirement timestamp.
          const retireAt = Date.now();
          for (const ch of this.channels.values()) {
            ch.miningSubmissionHashes.clear();
            if (clearExtendedJobs) {
              for (const ej of ch.extendedJobs.values()) {
                if (ej.retiredAt === undefined) ej.retiredAt = retireAt;
              }
            }
            ch.jobIdToDifficulty.clear();
          }
        }
        await this.broadcastNewJobToAllChannels(jt, jt.blockData.clearJobs);
        // After broadcast, run aging — any retired entries past the retention
        // window AND beyond the floor get GC'd. Cheap (typical channel has
        // <10 retired entries), runs at most once per block change.
        this.cleanupRetiredExtendedJobs();
      } catch (e) {
        console.error(`[SV2 ${this.sessionId}] Job send error:`, (e as Error).message);
        this.destroySocket();
      }
    });

    this.difficultyCheckInterval = setInterval(async () => {
      await this.checkDifficultyAllChannels();
    }, this.difficultyCheckIntervalMs);
  }

  /**
   * Per-channel extended-jobs aging. Mirrors the central jobs-service
   * `ageEntries` pattern: keep at least MIN_RETAINED entries newest-first
   * regardless of age; delete only entries with `retiredAt` set AND past
   * the retention window. Per-channel scope means each connection
   * maintains its own bounded extended-jobs map. Cost is O(N log N) on
   * sort but N is typically <30 (a few mins of jobs per channel).
   */
  private cleanupRetiredExtendedJobs(now: number = Date.now()): void {
    const MIN_RETAINED = 3;
    const retentionMs = SV2_EXTENDED_JOB_RETENTION_MS;
    for (const ch of this.channels.values()) {
      const entries = Array.from(ch.extendedJobs.entries());
      if (entries.length <= MIN_RETAINED) continue;

      const sortedNewestFirst = entries
        .slice()
        .sort(([, a], [, b]) => b.creation - a.creation);
      const candidates = sortedNewestFirst.slice(MIN_RETAINED);

      for (const [jobId, ej] of candidates) {
        if (ej.retiredAt !== undefined && now - ej.retiredAt > retentionMs) {
          ch.extendedJobs.delete(jobId);
          continue;
        }
        // Defense-in-depth — non-retired pile-up past 2× retention.
        if (now - ej.creation > retentionMs * 2) {
          ch.extendedJobs.delete(jobId);
        }
      }
    }
  }

  /**
   * Classify an extended job for share validation, mirroring
   * `StratumV1JobsService.classifyJobForShare`. Three outcomes per SV2
   * spec §5.3.14:
   *   - `'active'`            → never retired; normal validation
   *   - `'stale-creditable'`  → retired ≤ STALE_GRACE_MS ago; accept as
   *                             current (network-jitter absorption)
   *   - `'stale-rejected'`    → retired > STALE_GRACE_MS ago; reject
   *                             with wire `stale-share` (NOT
   *                             `invalid-job-id` — the job *was* known)
   *
   * Caller handles `null`/`undefined` extJob lookup as `invalid-job-id`
   * (genuinely missing — only reachable after retention GC).
   */
  private classifyExtendedJobForShare(ej: ExtendedJobData, now: number = Date.now()): 'active' | 'stale-creditable' | 'stale-rejected' {
    if (ej.retiredAt === undefined) return 'active';
    return (now - ej.retiredAt) <= SV2_STALE_GRACE_MS ? 'stale-creditable' : 'stale-rejected';
  }

  // ── Device Online Notification ───────────────────────────────────

  private notifyDeviceOnline(): void {
    if (this.deviceOnlineNotified) return;
    this.deviceOnlineNotified = true;
    this.deviceOfflineNotified = false;

    const startTime = new Date();
    this.clientService.getFirstSeenIfRecent(this.address!, this.workerName)
      .then(firstSeen => {
        this.notificationService.notifyDeviceStatusChange({
          address: this.address!,
          workerName: this.workerName,
          userAgent: this.userAgent,
          sessionId: this.sessionId,
          isOnline: true,
          timestamp: startTime,
          isReturning: firstSeen !== null,
        }).catch(err => console.error('Failed to notify device online status', err));
      })
      .catch(err => console.error('Failed to check firstSeen for device online notification', err));
  }

  // ── DB Entity ─────────────────────────────────────────────────────

  private async ensureEntity(): Promise<void> {
    if (this.entity) return;
    if (this.creatingEntity) {
      await this.creatingEntity;
      return;
    }
    if (!this.address) return;

    this.creatingEntity = (async () => {
      try {
        const firstSeen = await this.clientService.getFirstSeenIfRecent(this.address!, this.workerName);
        const startTime = new Date();
        this.entity = await this.clientService.insert({
          sessionId: this.sessionId,
          address: this.address!,
          clientName: this.workerName,
          userAgent: this.userAgent,
          startTime,
          firstSeen: firstSeen ?? startTime,
          bestDifficulty: 0,
          currentDifficulty: this.sessionDifficulty,
        });
      } catch (e) {
        console.error(`[SV2 ${this.sessionId}] Failed to create entity:`, e);
      }
    })();
    await this.creatingEntity;
  }

  // ── Frame Sending ─────────────────────────────────────────────────

  private getMsgTypeName(msgType: number): string {
    return SV2_MSG_TYPE_NAMES[msgType] || `Unknown(0x${msgType.toString(16)})`;
  }

  // Send a frame with a non-zero extension ID (e.g. Extension 1 responses)
  private async sendFrameWithExtension(msgType: number, payload: Buffer, extensionId: number): Promise<void> {
    return this.sendFrame(msgType, payload, extensionId);
  }

  private async sendFrame(msgType: number, payload: Buffer, extensionType: number): Promise<void> {
    if (this.destroyed) return;

    if (this.debugMessages) {
      const msgName = this.getMsgTypeName(msgType);
      console.log(`[SV2 ${this.sessionId}] 📤 TX: ${msgName} (0x${msgType.toString(16).padStart(2, '0')}) - ${payload.length} bytes`);
    }

    const frame = this.frameWriter.writeFrame(
      { extensionType, msgType, msgLength: payload.length },
      payload,
    );
    await this.writeRaw(frame);
  }

  private waitForData(minBytes: number = SV2_NOISE_ACT1_SIZE): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLen = 0;

      const onData = (data: Buffer) => {
        chunks.push(data);
        totalLen += data.length;
        if (totalLen >= minBytes) {
          cleanup();
          resolve(Buffer.concat(chunks));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeListener('data', onData);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for data after cipher negotiation (got ${totalLen}/${minBytes} bytes)`));
      }, 30000);

      this.socket.on('data', onData);
    });
  }

  private async writeRaw(data: Buffer): Promise<void> {
    if (this.socket.destroyed || this.socket.writableEnded) return;

    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // ── Share Hash ────────────────────────────────────────────────────

  private computeShareHash(submission: Sv2SubmitSharesStandard): string {
    return `${submission.jobId}:${submission.nonce}:${submission.ntime}:${submission.version}`;
  }

  // ── Utility ───────────────────────────────────────────────────────

  private generateSessionId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  public getCurrentDifficulty(): number | undefined {
    return this.sessionDifficulty;
  }

  public getSubmissionCacheForInterval(startTime: Date, endTime: Date): Array<{ time: Date; difficulty: number }> {
    if (!this.statistics) return [];
    const cache = this.statistics['submissionCache'] as Array<{ time: Date; difficulty: number }>;
    if (!cache) return [];
    return cache.filter(sub => sub.time >= startTime && sub.time < endTime);
  }

  public getAddress(): string | null {
    return this.address;
  }

  public getWorkerName(): string {
    return this.workerName;
  }

  public getChannelType(): 'standard' | 'extended' {
    if (this.primaryChannelId != null) {
      const channel = this.channels.get(this.primaryChannelId);
      if (channel) return channel.channelType;
    }
    return 'standard';
  }

  public getChannelCount(): number {
    return this.channels.size;
  }

  public getRemoteAddress(): string {
    return this.socket.remoteAddress || '';
  }

  // ── Sender: Reconnect (0x26) ──────────────────────────────────────

  public async sendReconnect(newHost: string, newPort: number): Promise<void> {
    const payload = serializeReconnect({ newHost, newPort });
    await this.sendFrame(Sv2MsgType.RECONNECT, payload, 0);
    console.log(`[SV2 ${this.sessionId}] Sent Reconnect → ${newHost}:${newPort}`);
    this.destroySocket();
  }

  // ── Sender: SetGroupChannel (0x25) ────────────────────────────────

  public async sendSetGroupChannel(groupChannelId: number, channelIds: number[]): Promise<void> {
    const payload = serializeSetGroupChannel({ groupChannelId, channelIds });
    await this.sendFrame(Sv2MsgType.SET_GROUP_CHANNEL, payload, 0);
    console.log(`[SV2 ${this.sessionId}] SetGroupChannel: channels [${channelIds.join(', ')}] → group ${groupChannelId}`);
  }

  // ── Sender: SetExtranoncePrefix (0x19) ────────────────────────────

  public async sendSetExtranoncePrefix(channelId: number, newPrefix: Buffer): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    channel.extranoncePrefix = newPrefix;
    const payload = serializeSetExtranoncePrefix({ channelId, extranoncePrefix: newPrefix });
    await this.sendFrame(Sv2MsgType.SET_EXTRANONCE_PREFIX, payload, SV2_CHANNEL_MSG_FLAG);
    console.log(`[SV2 ${this.sessionId}] SetExtranoncePrefix: channel ${channelId} → ${newPrefix.toString('hex')}`);
  }

  /**
   * Send a SetCustomMiningJob to this client (used by JDP bridge).
   * The declared job's coinbase + pool's current prevHash/nBits are combined.
   */
  public async sendSetCustomMiningJob(
    job: Sv2DeclareMiningJob,
    templateData: { template: any; prevHash: any },
    token: Buffer,
  ): Promise<void> {
    if (this.primaryChannelId == null) return;
    const channel = this.channels.get(this.primaryChannelId);
    if (!channel || channel.channelType !== 'extended') return;

    const requestId = parseInt(this.stratumV1JobsService.getNextId(), 16);
    this.stratumV1JobsService.latestJobId++;

    const customJobPayload = serializeSetCustomMiningJob({
      channelId: this.primaryChannelId,
      requestId,
      token,
      version: job.version,
      prevHash: templateData.prevHash.prevHash,
      minNtime: templateData.prevHash.headerTimestamp,
      nBits: templateData.prevHash.nBits,
      coinbaseTxVersion: templateData.template.coinbaseTxVersion ?? 2,
      coinbasePrefix: templateData.template.coinbasePrefix ?? job.coinbaseTxPrefix,
      coinbaseTxInputNSequence: templateData.template.coinbaseTxInputSequence ?? 0xffffffff,
      coinbaseTxOutputs: templateData.template.coinbaseTxOutputs ?? Buffer.alloc(0),
      coinbaseTxLocktime: templateData.template.coinbaseTxLocktime ?? 0,
      merklePath: templateData.template.merklePath,
    });

    await this.sendFrame(Sv2MsgType.SET_CUSTOM_MINING_JOB, customJobPayload, 0);

    // Store job-specific difficulty (SV2 spec: shares validated against target from when job was sent)
    channel.jobIdToDifficulty.set(requestId, channel.sessionDifficulty);

    // Store as extended job for share validation
    channel.extendedJobs.set(requestId, {
      coinbasePrefix: job.coinbaseTxPrefix,
      coinbaseSuffix: job.coinbaseTxSuffix,
      merklePath: templateData.template.merklePath,
      version: job.version,
      prevHash: templateData.prevHash.prevHash,
      nBits: templateData.prevHash.nBits,
      minNtime: templateData.prevHash.headerTimestamp,
      jobTemplate: null,
      creation: Date.now(),
    });

    console.log(`[SV2 ${this.sessionId}] Sent SetCustomMiningJob (requestId=${requestId})`);
  }

  public resetBestDifficulty(): void {
    if (this.entity) {
      this.entity.bestDifficulty = 0;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  private handleClose(): void {
    this.destroy().catch(err => console.error(`[SV2 ${this.sessionId}] Destroy error:`, err));
  }

  private handleTimeout(): void {
    console.log(`[SV2 ${this.sessionId}] Socket timeout`);
    this.socket.end();
    this.socket.destroy();
  }

  private handleError(err: NodeJS.ErrnoException): void {
    if (err.code === 'ECONNRESET') {
      console.log(`[SV2 ${this.sessionId}] Connection reset by peer (${this.address ?? 'pre-handshake'})`);
    } else {
      console.error(`[SV2 ${this.sessionId}] Socket error:`, err.message);
    }
    this.socket.destroy();
  }

  private destroySocket(): void {
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Device offline notification
    if (this.address && this.deviceOnlineNotified && !this.deviceOfflineNotified) {
      this.deviceOfflineNotified = true;
      try {
        await this.notificationService.notifyDeviceStatusChange({
          address: this.address,
          workerName: this.workerName,
          userAgent: this.entity?.userAgent ?? this.userAgent,
          sessionId: this.entity?.sessionId ?? this.sessionId,
          isOnline: false,
          timestamp: new Date(),
        });
      } catch (err) {
        console.error('Failed to notify device offline status', err);
      }
    }

    // Delete DB entity
    const sid = this.entity?.sessionId || this.sessionId;
    if (sid) {
      await this.clientService.delete(sid).catch(() => {});
    }

    // Unregister from service
    if (this.address) {
      this.stratumV2Service.unregisterClient(this.address, this);
    }

    // Unsubscribe from jobs
    if (this.stratumSubscription) {
      this.stratumSubscription.unsubscribe();
      this.stratumSubscription = null;
    }

    // Unsubscribe TDP streaming subscriptions
    for (const sub of this.tdpSubscriptions) {
      sub.unsubscribe();
    }
    this.tdpSubscriptions = [];

    // Release extranonce prefixes for all channels
    if (this.extranonceManager) {
      for (const channel of this.channels.values()) {
        if (channel.channelType === 'extended') {
          this.extranonceManager.release(channel.channelId);
        }
      }
    }

    // Clear channels
    this.channels.clear();
    this.primaryChannelId = null;

    // Clear intervals
    if (this.difficultyCheckInterval) {
      clearInterval(this.difficultyCheckInterval as any);
      this.difficultyCheckInterval = null;
    }

    // Remove all socket listeners to prevent memory leaks
    this.socket.removeAllListeners();

    console.log(`[SV2 ${this.sessionId}] Client disconnected (${this.address ?? 'unknown'})`);
  }
}
