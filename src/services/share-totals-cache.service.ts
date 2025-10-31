import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';

interface TotalsEntry {
  baseline: number;
  delta: number;
}

/**
 * Caches aggregate share totals per address and per worker.
 *
 * Totals are hydrated from the historical aggregates on first use and then
 * incrementally updated as new shares arrive. A periodic flush persists the
 * accumulated deltas back to durable storage so that cached values remain
 * consistent across restarts. Recent deltas can be lost if the process stops
 * unexpectedly before the next flush completes.
 */
@Injectable()
export class ShareTotalsCacheService implements OnModuleDestroy {
  private readonly addressTotals = new Map<string, TotalsEntry>();
  private readonly workerTotals = new Map<string, Map<string, TotalsEntry>>();
  private readonly addressHydrations = new Map<string, Promise<void>>();
  private readonly workerHydrations = new Map<string, Promise<void>>();
  private readonly flushIntervalMs: number;
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly configService: ConfigService,
  ) {
    const configuredInterval = parseInt(
      this.configService.get<string>('SHARE_TOTALS_FLUSH_INTERVAL_MS') ?? '',
      10,
    );
    if (Number.isFinite(configuredInterval) && configuredInterval > 0) {
      this.flushIntervalMs = configuredInterval;
    } else if (configuredInterval === 0) {
      this.flushIntervalMs = 0;
    } else {
      this.flushIntervalMs = 5 * 60 * 1000;
    }
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch((error) => {
          console.error('ShareTotalsCacheService flush failed', error);
        });
      }, this.flushIntervalMs);
      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  public async increment(
    address: string,
    workerName: string | undefined,
    difficulty: number,
  ): Promise<void> {
    if (!address || !Number.isFinite(difficulty) || difficulty <= 0) {
      return;
    }

    await this.ensureAddressBaseline(address);
    const addressEntry = this.addressTotals.get(address);
    if (addressEntry) {
      addressEntry.delta += difficulty;
    }

    if (workerName) {
      await this.ensureWorkerBaseline(address);
      let workerMap = this.workerTotals.get(address);
      if (!workerMap) {
        workerMap = new Map();
        this.workerTotals.set(address, workerMap);
      }
      let workerEntry = workerMap.get(workerName);
      if (!workerEntry) {
        workerEntry = { baseline: 0, delta: 0 };
        workerMap.set(workerName, workerEntry);
      }
      workerEntry.delta += difficulty;
    }
  }

  public async getAddressTotal(address: string): Promise<number> {
    await this.ensureAddressBaseline(address);
    const entry = this.addressTotals.get(address);
    if (!entry) {
      return this.clientStatisticsService.getTotalSharesForAddress(address);
    }
    return entry.baseline + entry.delta;
  }

  public async getWorkerTotals(
    address: string,
  ): Promise<Array<{ workerName: string; total: number }>> {
    await this.ensureWorkerBaseline(address);
    const workerMap = this.workerTotals.get(address);
    if (!workerMap) {
      const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
        address,
      );
      return totals.map((entry) => ({
        workerName: entry.clientName,
        total: entry.total,
      }));
    }
    const result: Array<{ workerName: string; total: number }> = [];
    for (const [workerName, entry] of workerMap.entries()) {
      result.push({ workerName, total: entry.baseline + entry.delta });
    }
    return result;
  }

  public async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [address, entry] of this.addressTotals.entries()) {
      if (entry.delta <= 0) {
        continue;
      }
      const delta = entry.delta;
      entry.baseline += delta;
      entry.delta = 0;
      pending.push(
        this.addressSettingsService
          .addShares(address, delta)
          .catch((error) => {
            entry.baseline -= delta;
            entry.delta += delta;
            console.error('ShareTotalsCacheService failed to persist shares', error);
          })
          .then(() => void 0),
      );
    }

    for (const workerMap of this.workerTotals.values()) {
      for (const entry of workerMap.values()) {
        if (entry.delta > 0) {
          entry.baseline += entry.delta;
          entry.delta = 0;
        }
      }
    }

    await Promise.all(pending);
  }

  private async ensureAddressBaseline(address: string): Promise<void> {
    if (this.addressTotals.has(address)) {
      return;
    }
    let hydration = this.addressHydrations.get(address);
    if (!hydration) {
      hydration = (async () => {
        const total = await this.clientStatisticsService.getTotalSharesForAddress(
          address,
        );
        this.addressTotals.set(address, { baseline: total, delta: 0 });
      })();
      this.addressHydrations.set(address, hydration);
    }
    await hydration;
  }

  private async ensureWorkerBaseline(address: string): Promise<void> {
    if (this.workerTotals.has(address)) {
      return;
    }
    let hydration = this.workerHydrations.get(address);
    if (!hydration) {
      hydration = (async () => {
        const totals = await this.clientStatisticsService.getTotalSharesForWorkers(
          address,
        );
        const entries = new Map<string, TotalsEntry>();
        for (const total of totals) {
          entries.set(total.clientName, { baseline: total.total, delta: 0 });
        }
        this.workerTotals.set(address, entries);
      })();
      this.workerHydrations.set(address, hydration);
    }
    await hydration;
  }
}
