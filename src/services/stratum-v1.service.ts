import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
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

@Injectable()
export class StratumV1Service implements OnModuleInit {
  private readonly clientsByAddress = new Map<string, Set<StratumV1Client>>();

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    private readonly externalSharesService: ExternalSharesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_APP_INSTANCE == '0') {
      await this.clientService.deleteAll();
    }
    setTimeout(() => {
      this.startSocketServer();
    }, 1000 * 10);
  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {
      // Disable Nagle's algorithm and use UTF-8 encoding for better latency
      socket.setNoDelay(true);
      socket.setEncoding('utf8');

      //5 min
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
        this.poolShareStatisticsService,
        this.poolRejectedStatisticsService,
        this.clientRejectedStatisticsService,
        this.externalSharesService,
        this,
      );

      socket.on('close', async (hadError: boolean) => {
        if (client.sessionId != null) {
          // Handle socket disconnection
          await client.destroy();
          this.unregisterClient(client.address, client);
          console.log(
            `Client ${client.sessionId} disconnected, hadError?:${hadError}`,
          );
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

      //   //console.log(`Client disconnected, socket error,  ${client.sessionId}`);
    });

    server.listen(process.env.STRATUM_PORT, () => {
      console.log(
        `Stratum server is listening on port ${process.env.STRATUM_PORT}`,
      );
    });
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
}
