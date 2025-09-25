import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly clientService: ClientService,
    private readonly dataSource: DataSource,
    private readonly rpcBlockService: RpcBlockService,
  ) {}

  async onModuleInit() {
    // Optional: Nur wenn du das wirklich willst – VACUUM ist bei PG anders als bei SQLite.
    // if (process.env.NODE_APP_INSTANCE === '0') {
    //   await this.dataSource.query(`VACUUM;`);
    // }

    // DB-spezifische Tuning-Einstellungen
    const dbType = (this.dataSource.options as any)?.type;

    try {
      if (dbType === 'sqlite') {
        // Nur für SQLite gültig
        // Normal ist in WAL-Mode sicher, und Checkpoints warten auf fsync.
        await this.dataSource.query(`PRAGMA synchronous = OFF;`);
        // Beispielhaft aus deinem Kommentar:
        // await this.dataSource.query(`PRAGMA cache_size = -500000;`); // ~500MB
        // await this.dataSource.query(`PRAGMA mmap_size = 6000000000;`); // ~6GB
      } else if (dbType === 'postgres') {
        // PostgreSQL-Äquivalent pro Session (kein PRAGMA in PG)
        // Achtung: synchronous_commit=off kann Datenverlust bei Crash bedeuten.
        await this.dataSource.query(`SET SESSION synchronous_commit TO OFF;`);
        // Weitere PG-Settings wären global in postgresql.conf sinnvoller als hier.
      }
    } catch (e) {
      // Falls der DB-User z.B. kein SET darf: nicht crashen lassen.
      console.warn('DB tuning skipped:', e);
    }

    if (process.env.NODE_APP_INSTANCE === undefined) {
      await this.clientService.deleteAll();
    }

    if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE === '0') {
      setInterval(async () => {
        await this.deleteOldStatistics();
      }, 1000 * 60 * 60);

      setInterval(async () => {
        console.log('Killing dead clients');
        await this.clientService.killDeadClients();
      }, 1000 * 60 * 5);

      setInterval(async () => {
        console.log('Deleting Old Blocks');
        await this.rpcBlockService.deleteOldBlocks();
      }, 1000 * 60 * 60 * 24);
    }
  }

  private async deleteOldStatistics() {
    console.log('Deleting statistics');
    await this.clientStatisticsService.deleteOldStatistics();
    console.log('Deleted old statistics');
    const deletedClients = await this.clientService.deleteOldClients();
    console.log(`Deleted ${deletedClients.affected} old clients`);
  }
}
