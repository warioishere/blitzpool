import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { StratumPortConfig } from '../models/interfaces/unified-stratum.interfaces';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { ExternalSharesService } from './external-shares.service';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';
import { AddressSettingsCacheService } from './address-settings-cache.service';
import { DifficultyScoresCacheService } from './difficulty-scores-cache.service';
import { PplnsService } from './pplns.service';
import { GroupSoloService } from './group-solo.service';
import { MinerActiveModeService } from './miner-active-mode.service';
import { PoolModeHashrateService } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.service';

@Injectable()
export class StratumV1Service implements OnModuleInit {
  private readonly clientsByAddress = new Map<string, Set<StratumV1Client>>();
  private redisClient: any = null;

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly addressSettingsCacheService: AddressSettingsCacheService,
    private readonly difficultyScoresCacheService: DifficultyScoresCacheService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    private readonly externalSharesService: ExternalSharesService,
    private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
    private readonly shareTotalsCacheService: ShareTotalsCacheService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly pplnsService: PplnsService,
    private readonly groupSoloService: GroupSoloService,
    private readonly minerActiveModeService: MinerActiveModeService,
    private readonly poolModeHashrateService: PoolModeHashrateService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Extract Redis client for passing to StratumV1ClientStatistics
    try {
      const store: any = this.cacheManager.store;
      if (store && store.client) {
        this.redisClient = store.client;
        console.log('[StratumV1Service] Redis client available for client statistics');
      }
    } catch (error) {
      console.warn('[StratumV1Service] Failed to access Redis client:', error);
    }

    // NOTE: Server startup has been moved to ProtocolDetectorService.
    // This service now only handles V1 client management and business logic.
  }

  /**
   * Handle a new V1 connection routed by the ProtocolDetectorService.
   * Creates a StratumV1Client and wires up socket event handlers.
   *
   * @param socket - The raw TCP socket (already detected as V1)
   * @param firstChunk - The first data chunk (used for protocol detection, re-emitted to client)
   * @param portConfig - Configuration for the port the connection arrived on
   */
  handleV1Connection(
    socket: Socket,
    firstChunk: Buffer,
    portConfig: StratumPortConfig,
  ): void {
    // Set UTF-8 encoding for V1 text protocol
    socket.setEncoding('utf8');

    // 5 min timeout (matches original behavior)
    socket.setTimeout(1000 * 60 * 5);

    const client = new StratumV1Client(
      socket,
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
      this,
      portConfig.initialDifficulty,
      portConfig.allowSuggestedDifficulty,
      portConfig.targetSharesPerMinute,
      this.redisClient,
      portConfig.payoutMode ?? 'solo',
      this.pplnsService,
      this.groupSoloService,
      this.minerActiveModeService,
      this.poolModeHashrateService,
      portConfig.minimumDifficulty ?? 0,
      portConfig.ledgerWarmupShares ?? 0,
    );

    socket.on('close', async (hadError: boolean) => {
      if (client.sessionId != null) {
        await client.destroy();
        this.unregisterClient(client.address, client);
        console.log(
          `Client ${client.sessionId} disconnected, hadError?:${hadError}`,
        );
      } else {
        // Client disconnected before completing handshake — clean up listeners
        socket.removeAllListeners();
      }
    });

    socket.on('timeout', () => {
      console.log('socket timeout');
      socket.end();
      socket.destroy();
    });

    socket.on('error', async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') {
        console.error('Socket error', error);
      }
      socket.destroy();
    });

    // Re-emit the first chunk so the StratumV1Client's data handler processes it.
    // The client constructor sets up a 'data' listener, so emitting after construction works.
    socket.emit('data', firstChunk.toString('utf8'));
  }

  registerClient(address: string, client: StratumV1Client) {
    if (!address) {
      return;
    }
    if (!this.clientsByAddress.has(address)) {
      this.clientsByAddress.set(address, new Set());
    }
    this.clientsByAddress.get(address).add(client);
  }

  unregisterClient(address: string | undefined, client: StratumV1Client) {
    if (!address) {
      return;
    }
    const clients = this.clientsByAddress.get(address);
    if (!clients) {
      return;
    }
    clients.delete(client);
    if (clients.size === 0) {
      this.clientsByAddress.delete(address);
    }
  }

  getCurrentDifficulties(address: string): Map<string, number> {
    const clients = this.clientsByAddress.get(address);
    if (!clients) {
      return new Map();
    }

    const difficulties = new Map<string, number>();
    for (const client of clients) {
      const sessionId = client.sessionId;
      if (!sessionId) {
        continue;
      }

      const currentDifficulty = client.getCurrentDifficulty();
      if (currentDifficulty != null) {
        difficulties.set(sessionId, currentDifficulty);
      }
    }

    return difficulties;
  }

  /**
   * Reset bestDifficulty for all workers of an address.
   * Updates database, clears caches, and resets in-memory workers.
   */
  async resetBestDifficultyForAddress(address: string): Promise<void> {
    await this.clientService.resetBestDifficultyForAddress(address);
    await this.addressSettingsCacheService.clear(address);
    await this.difficultyScoresCacheService.clearCache(address);

    const clients = this.clientsByAddress.get(address);
    if (clients && clients.size > 0) {
      console.log(`[StratumV1Service] Resetting ${clients.size} in-memory workers for address ${address}`);
      for (const client of clients) {
        client.resetBestDifficulty();
      }
    }
  }

  resetClientsForAddress(address: string) {
    const clients = this.clientsByAddress.get(address);
    if (!clients) {
      return;
    }
    for (const client of clients) {
      try {
        client.socket.end();
        client.socket.destroy();
      } catch {
        // ignore errors while closing sockets
      }
    }
    this.clientsByAddress.delete(address);
  }

  // Live hashrate service accessors
  getClientsForAddress(address: string): Set<StratumV1Client> {
    return this.clientsByAddress.get(address) || new Set();
  }

  getAllClients(): StratumV1Client[] {
    const allClients: StratumV1Client[] = [];
    this.clientsByAddress.forEach(clients => {
      clients.forEach(client => allClients.push(client));
    });
    return allClients;
  }

  getAllAddresses(): string[] {
    return Array.from(this.clientsByAddress.keys());
  }
}
