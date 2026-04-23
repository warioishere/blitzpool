import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Socket } from 'net';
import * as crypto from 'crypto';

import { IProtocolHandler, StratumPortConfig } from '../models/interfaces/unified-stratum.interfaces';
import { StratumV2Client } from '../models/StratumV2Client';
import {
  generateServerKeypair,
  xOnlyPubKeyFromPriv,
  createSignatureNoiseMessage,
  Sv2ServerKeypair,
  Sv2SignatureNoiseMessage,
  Sv2NoiseConfig,
} from '../models/sv2/sv2-noise';
import { Sv2ExtranonceManager } from '../models/sv2/sv2-extranonce-manager';

import { normalizeIp } from '../utils/network.utils';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { TemplateDistributionService } from './template-distribution.service';
import { JobDeclarationService } from './job-declaration.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { NotificationService } from './notification.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { AddressSettingsCacheService } from './address-settings-cache.service';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ExternalSharesService } from './external-shares.service';
import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';
import { PplnsService } from './pplns.service';
import { GroupSoloService } from './group-solo.service';
import { MinerActiveModeService } from './miner-active-mode.service';
import { DifficultyScoresCacheService } from './difficulty-scores-cache.service';

interface GroupChannel {
  groupChannelId: number;
  channelIds: Set<number>;
  sharedDifficulty: number;
}

@Injectable()
export class StratumV2Service implements OnModuleInit, IProtocolHandler {
  private readonly clientsByAddress = new Map<string, Set<StratumV2Client>>();
  private channelIdCounter = 1;
  private readonly extranonceManager = new Sv2ExtranonceManager();

  // Group channel tracking
  private groupChannels = new Map<number, GroupChannel>();
  private groupChannelIdCounter = 1;

  // Authority key (signs server certificates)
  private authorityPrivKey!: Buffer;
  private authorityPubKeyXOnly!: Buffer;

  // Server static keypair (EllSwift) + certificate
  private serverKeypair!: Sv2ServerKeypair;
  private certificate!: Sv2SignatureNoiseMessage;


  constructor(
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    @Inject(forwardRef(() => NotificationService))
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly addressSettingsCacheService: AddressSettingsCacheService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    private readonly externalSharesService: ExternalSharesService,
    private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
    private readonly shareTotalsCacheService: ShareTotalsCacheService,
    private readonly difficultyScoresCacheService: DifficultyScoresCacheService,
    private readonly templateDistributionService: TemplateDistributionService,
    @Inject(forwardRef(() => JobDeclarationService))
    private readonly jobDeclarationService: JobDeclarationService,
    private readonly pplnsService: PplnsService,
    private readonly groupSoloService: GroupSoloService,
    private readonly minerActiveModeService: MinerActiveModeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initAuthorityKey();
    await this.initServerKeypair();

    console.log('[StratumV2Service] Initialized - authority pubkey:', this.authorityPubKeyXOnly.toString('hex'));
  }

  private async initAuthorityKey(): Promise<void> {
    const envKey = this.configService.get<string>('SV2_AUTHORITY_PRIVKEY');
    if (envKey && envKey.length === 64) {
      this.authorityPrivKey = Buffer.from(envKey, 'hex');
    } else {
      this.authorityPrivKey = crypto.randomBytes(32);
      console.warn('[StratumV2Service] SV2_AUTHORITY_PRIVKEY not set - generated random authority key');
    }
    this.authorityPubKeyXOnly = xOnlyPubKeyFromPriv(this.authorityPrivKey);
    console.log('[StratumV2Service] Authority public key (x-only):', this.authorityPubKeyXOnly.toString('hex'));
  }

  private async initServerKeypair(): Promise<void> {
    this.serverKeypair = await generateServerKeypair();
    this.regenerateCertificate();
  }

  private regenerateCertificate(): void {
    const now = Math.floor(Date.now() / 1000);
    const validFrom = now - 3600; // 1 hour ago
    const notValidAfter = now + 86400; // 24 hours from now
    const staticPubKeyXOnly = xOnlyPubKeyFromPriv(this.serverKeypair.privateKey);
    this.certificate = createSignatureNoiseMessage(
      this.authorityPrivKey,
      staticPubKeyXOnly,
      validFrom,
      notValidAfter,
    );
  }

  /** Rotate certificate every 12 hours */
  @Interval(12 * 60 * 60 * 1000)
  handleCertificateRotation(): void {
    this.regenerateCertificate();
    console.log('[StratumV2Service] Certificate rotated');
  }

  /** Get the current Noise config for new connections */
  getNoiseConfig(): Sv2NoiseConfig {
    return {
      staticKeypair: this.serverKeypair,
      certificateMessage: this.certificate,
    };
  }

  /** Allocate a unique channel ID */
  getNextChannelId(): number {
    return this.channelIdCounter++;
  }

  /**
   * Generate a 4-byte extranonce prefix: <2-byte counter><2-byte random>
   */
  generateExtranoncePrefix(): Buffer {
    const counter = this.channelIdCounter & 0xffff;
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(counter, 0);
    crypto.randomBytes(2).copy(buf, 2);
    return buf;
  }

  /**
   * Handle a new V2 connection routed by the ProtocolDetectorService.
   */
  handleConnection(
    socket: Socket,
    firstChunk: Buffer,
    portConfig: StratumPortConfig,
  ): void {
    const client = new StratumV2Client(
      socket,
      firstChunk,
      portConfig,
      this,
      this.stratumV1JobsService,
      this.bitcoinRpcService,
      this.clientService,
      this.clientStatisticsService,
      this.notificationService,
      this.blocksService,
      this.configService,
      this.addressSettingsService,
      this.addressSettingsCacheService,
      this.poolShareStatisticsService,
      this.poolRejectedStatisticsService,
      this.clientRejectedStatisticsService,
      this.externalSharesService,
      this.clientDifficultyStatisticsService,
      this.shareTotalsCacheService,
      this.extranonceManager,
      this.templateDistributionService,
      this.pplnsService,
      this.groupSoloService,
      this.minerActiveModeService,
    );

    // Client self-registers when channel is opened and self-unregisters on close.
    // The constructor initiates the async handshake.
  }

  registerClient(address: string, client: StratumV2Client): void {
    if (!address) return;
    if (!this.clientsByAddress.has(address)) {
      this.clientsByAddress.set(address, new Set());
    }
    this.clientsByAddress.get(address)!.add(client);
  }

  unregisterClient(address: string | undefined, client: StratumV2Client): void {
    if (!address) return;
    const clients = this.clientsByAddress.get(address);
    if (!clients) return;
    clients.delete(client);
    if (clients.size === 0) {
      this.clientsByAddress.delete(address);
    }
  }

  getClientsForAddress(address: string): Set<StratumV2Client> {
    return this.clientsByAddress.get(address) || new Set();
  }

  getAllAddresses(): string[] {
    return Array.from(this.clientsByAddress.keys());
  }

  getAllClients(): StratumV2Client[] {
    const allClients: StratumV2Client[] = [];
    this.clientsByAddress.forEach(clients => {
      clients.forEach(client => allClients.push(client));
    });
    return allClients;
  }

  /**
   * Check if there's a JDP connection from the given IP address.
   * Used to detect JD clients and skip sending pool jobs to them.
   */
  hasJdpConnectionFromIp(ipAddress: string): boolean {
    if (!this.jobDeclarationService) {
      return false;
    }
    const normalizedIpAddr = normalizeIp(ipAddress);

    // Check if any JDP client is connected from this IP
    const jdpClients = Array.from((this.jobDeclarationService as any).clients.values());
    return jdpClients.some((jdpClient: any) => {
      const jdpIp = normalizeIp(jdpClient.remoteAddress ?? '');
      return jdpIp === normalizedIpAddr;
    });
  }

  getCurrentDifficulties(address: string): Map<string, number> {
    const clients = this.clientsByAddress.get(address);
    if (!clients) {
      return new Map();
    }

    const difficulties = new Map<string, number>();
    for (const client of clients) {
      if (!client.sessionId) continue;
      const diff = client.getCurrentDifficulty();
      if (diff != null) {
        difficulties.set(client.sessionId, diff);
      }
    }

    return difficulties;
  }

  /**
   * Reset bestDifficulty for all V2 workers of an address.
   * Updates database, clears caches, and resets in-memory workers.
   */
  async resetBestDifficultyForAddress(address: string): Promise<void> {
    await this.clientService.resetBestDifficultyForAddress(address);
    await this.addressSettingsCacheService.clear(address);
    await this.difficultyScoresCacheService.clearCache(address);

    const clients = this.clientsByAddress.get(address);
    if (clients && clients.size > 0) {
      console.log(`[StratumV2Service] Resetting ${clients.size} in-memory V2 workers for address ${address}`);
      for (const client of clients) {
        client.resetBestDifficulty();
      }
    }
  }

  // ── Group Channel Management ──────────────────────────────────────

  createGroupChannel(sharedDifficulty: number): number {
    const groupChannelId = this.groupChannelIdCounter++;
    this.groupChannels.set(groupChannelId, {
      groupChannelId,
      channelIds: new Set(),
      sharedDifficulty,
    });
    return groupChannelId;
  }

  assignToGroupChannel(groupChannelId: number, channelId: number, client: StratumV2Client): void {
    const group = this.groupChannels.get(groupChannelId);
    if (!group) {
      console.warn(`[StratumV2Service] Unknown group channel ${groupChannelId}`);
      return;
    }
    group.channelIds.add(channelId);
    client.sendSetGroupChannel(groupChannelId, [channelId]).catch(err => {
      console.error(`[StratumV2Service] Failed to send SetGroupChannel:`, err);
    });
  }

  getGroupChannel(groupChannelId: number): GroupChannel | undefined {
    return this.groupChannels.get(groupChannelId);
  }

  // ── Reconnect Broadcast ───────────────────────────────────────────

  async sendReconnectToAddress(address: string, newHost: string, newPort: number): Promise<void> {
    const clients = this.clientsByAddress.get(address);
    if (!clients) return;
    for (const client of clients) {
      await client.sendReconnect(newHost, newPort);
    }
  }
}
