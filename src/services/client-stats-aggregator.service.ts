import { Injectable } from '@nestjs/common';
import { NumberSuffix } from '../utils/NumberSuffix';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { HashrateHistoryService } from './hashrate-history.service';

export interface WorkerStats {
  workername: string;
  hashrate1m: string;
  hashrate5m: string;
  hashrate1hr: string;
  hashrate1d: string;
  hashrate7d: string;
  lastshare: number | null;
  shares: number;
  rejected: number;
  bestshare: number;
  bestshareever: number;
}

export interface AddressStats {
  hashrate1m: string;
  hashrate5m: string;
  hashrate1hr: string;
  hashrate1d: string;
  hashrate7d: string;
  lastshare: number | null;
  workers: number;
  shares: number;
  rejected: number;
  bestever: number;
  worker: WorkerStats[];
}

@Injectable()
export class ClientStatsAggregator {
  private suffix = new NumberSuffix();

  constructor(
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    private readonly hashrateHistory: HashrateHistoryService,
  ) {}

  public async getStats(address: string): Promise<AddressStats> {
    const workers = await this.clientService.getByAddress(address);
    const shares = await this.clientStatisticsService.getTotalSharesForAddress(address);
    const rejectedTotals = await this.clientRejectedStatisticsService.getTotalsSince(address, 0, undefined, true);
    const rejected = Object.values(rejectedTotals).reduce((a, b) => a + b, 0);
    const addrSettings = await this.addressSettingsService.getSettings(address, false);
    const now = Date.now();

    const totalHashrateNow = workers.reduce((sum, w) => sum + (w.hashRate || 0), 0);
    this.hashrateHistory.record(address, null, totalHashrateNow);
    workers.forEach(w => this.hashrateHistory.record(address, w.clientName, w.hashRate || 0));

    const result: AddressStats = {
      hashrate1m: this.suffix.to(
        this.hashrateHistory.getAverage(address, 1)
      ),
      hashrate5m: this.suffix.to(
        this.hashrateHistory.getAverage(address, 5)
      ),
      hashrate1hr: this.suffix.to(
        await this.clientStatisticsService.getHashRate({
          address,
          since: now - 60 * 60 * 1000,
          useActualWindow: true,
        }),
      ),
      hashrate1d: this.suffix.to(
        await this.clientStatisticsService.getHashRate({
          address,
          since: now - 24 * 60 * 60 * 1000,
          useActualWindow: true,
        }),
      ),
      hashrate7d: this.suffix.to(
        await this.clientStatisticsService.getHashRate({
          address,
          since: now - 7 * 24 * 60 * 60 * 1000,
          useActualWindow: true,
        }),
      ),
      lastshare: await this.clientStatisticsService.getLastShareTime(address),
      workers: workers.length,
      shares,
      rejected,
      bestever: addrSettings?.bestDifficulty || 0,
      worker: [],
    };

    const workerShareTotals = await this.clientStatisticsService.getTotalSharesForWorkers(address);
    const workerRejectedTotals = await this.clientRejectedStatisticsService.getTotalsByWorkerSince(address, 0, true);

    result.worker = await Promise.all(
      workers.map(async worker => {
        const wShares = workerShareTotals.find(w => w.clientName === worker.clientName)?.total || 0;
        const wRejected = workerRejectedTotals[worker.clientName] || 0;
        const bestShareEver = await this.clientService.getBestShareEver(address, worker.clientName);
        return {
          workername: worker.clientName,
          hashrate1m: this.suffix.to(
            this.hashrateHistory.getAverage(address, 1, worker.clientName)
          ),
          hashrate5m: this.suffix.to(
            this.hashrateHistory.getAverage(address, 5, worker.clientName)
          ),
          hashrate1hr: this.suffix.to(
            await this.clientStatisticsService.getHashRate({
              address,
              clientName: worker.clientName,
              since: now - 60 * 60 * 1000,
              useActualWindow: true,
            }),
          ),
          hashrate1d: this.suffix.to(
            await this.clientStatisticsService.getHashRate({
              address,
              clientName: worker.clientName,
              since: now - 24 * 60 * 60 * 1000,
              useActualWindow: true,
            }),
          ),
          hashrate7d: this.suffix.to(
            await this.clientStatisticsService.getHashRate({
              address,
              clientName: worker.clientName,
              since: now - 7 * 24 * 60 * 60 * 1000,
              useActualWindow: true,
            }),
          ),
          lastshare: await this.clientStatisticsService.getLastShareTime(
            address,
            worker.clientName,
          ),
          shares: wShares,
          rejected: wRejected,
          bestshare: worker.bestDifficulty,
          bestshareever: bestShareEver,
        } as WorkerStats;
      }),
    );

    return result;
  }
}
