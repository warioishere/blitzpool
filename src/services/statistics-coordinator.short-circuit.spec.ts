/**
 * Tier A short-circuit + Tier B dirty-set tests for the StatisticsCoordinator.
 *
 * Tier A: slot-bound flushers (poolShares, poolModeHashrate, clientStatistics,
 * poolRejected, clientRejected) only have new data at slot transitions.
 * On every other tick they used to SCAN Redis, find their keys, filter all
 * out as "current-slot", return nothing. With Tier A the flusher
 * short-circuits at function entry when `currentSlot === lastFlushedSlot`,
 * skipping the SCAN entirely.
 *
 * Tier B: running-total flushers (flushAddressTotals, flushWorkerTotals)
 * read the dirty-set via SMEMBERS instead of SCAN over the full Redis
 * keyspace. Bootstrap on first run via one-shot SCAN if the set is empty.
 *
 * Together: 9/10 ticks do effectively zero work (just smembers calls).
 * The 10th tick (slot transition) does full SCAN+flush+update.
 */

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { DataSource } from 'typeorm';

jest.mock('node-telegram-bot-api', () => ({}));

import { StatisticsCoordinatorService } from './statistics-coordinator.service';
import { TimeSlotHelper } from '../utils/time-slot.helper';

function buildService(mockRedis: any) {
  const service = new StatisticsCoordinatorService(
    { store: {} } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { options: { type: 'postgres' }, query: jest.fn() } as unknown as DataSource,
    { addSharesBulk: jest.fn().mockResolvedValue(undefined) } as any,
    { addSharesBulk: jest.fn().mockResolvedValue(undefined), addRejectedBulk: jest.fn().mockResolvedValue(undefined) } as any,
    {
      drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
      drainWorkerDeltas: jest.fn().mockReturnValue([]),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    } as any,
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolModeHashrateService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolShareStatisticsService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolRejectedStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientRejectedStatisticsService
  );
  (service as any).redisClient = mockRedis;
  return service;
}

function makeMockRedis(overrides: any = {}) {
  const sAdd = jest.fn().mockResolvedValue(1);
  const sRem = jest.fn().mockResolvedValue(1);
  const del = jest.fn().mockResolvedValue(undefined);
  return {
    scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }),
    hGetAll: jest.fn().mockResolvedValue({}),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd,
    sRem,
    del,
    multi: jest.fn(function (this: any) {
      const ops: any[] = [];
      const chain: any = {
        hGetAll: (k: string) => { ops.push({ op: 'hGetAll', k }); return chain; },
        hIncrByFloat: (k: string, f: string, v: number) => { ops.push({ op: 'hIncrByFloat', k, f, v }); return chain; },
        hSet: (k: string, f: string, v: string) => { ops.push({ op: 'hSet', k, f, v }); return chain; },
        exec: jest.fn().mockResolvedValue([]),
      };
      return chain;
    }),
    ...overrides,
  };
}

describe('StatisticsCoordinator — slot-bucketed flushers (in-memory)', () => {
  // After Phase B, ALL 5 slot-bucketed flushers (poolShares, poolModeHashrate,
  // clientStatistics, poolRejected, clientRejected) buffer in process memory
  // and never call Redis SCAN. The slot-short-circuit pattern is obsolete —
  // the drain/confirm flow uses the empty-snapshot fast path instead.

  it('none of the 5 flushers call Redis SCAN', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();

    expect(mockRedis.scan).not.toHaveBeenCalled();
  });

  it('repeated flush ticks with empty caches stay a no-op (fast path on empty drain)', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    for (let i = 0; i < 5; i++) {
      await (service as any).flushPoolShares();
      await (service as any).flushPoolModeHashrate();
      await (service as any).flushClientStatistics();
      await (service as any).flushPoolRejectedStatistics();
      await (service as any).flushClientRejectedStatistics();
    }

    expect(mockRedis.scan).not.toHaveBeenCalled();
  });
});

describe('StatisticsCoordinator — in-memory address/worker total flush', () => {
  function buildServiceWithCache(cache: any, addressSettings: any, workerShares: any) {
    const service = new StatisticsCoordinatorService(
      { store: {} } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { options: { type: 'postgres' }, query: jest.fn() } as unknown as DataSource,
      addressSettings,
      workerShares,
      cache,
      {
        drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
        confirmFlush: jest.fn(),
      } as any,
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolShareStatisticsService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolRejectedStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientRejectedStatisticsService
    );
    (service as any).redisClient = makeMockRedis();
    return service;
  }

  it('flushAddressTotals: drains cache, bulk-upserts to PG, then confirms', async () => {
    const drained = new Map<string, number>([
      ['addr1', 10],
      ['addr2', 25],
    ]);
    const cache = {
      drainAddressDeltas: jest.fn().mockReturnValue(drained),
      drainWorkerDeltas: jest.fn().mockReturnValue([]),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    };
    const addressSettings = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };
    const workerShares = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };

    const service = buildServiceWithCache(cache, addressSettings, workerShares);
    await (service as any).flushAddressTotals();

    expect(cache.drainAddressDeltas).toHaveBeenCalledTimes(1);
    expect(addressSettings.addSharesBulk).toHaveBeenCalledWith(expect.arrayContaining([
      { address: 'addr1', shares: 10 },
      { address: 'addr2', shares: 25 },
    ]));
    expect(cache.confirmAddressFlush).toHaveBeenCalledWith(drained);
  });

  it('flushAddressTotals: empty cache returns without touching PG', async () => {
    const cache = {
      drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
      drainWorkerDeltas: jest.fn().mockReturnValue([]),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    };
    const addressSettings = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };
    const workerShares = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };

    const service = buildServiceWithCache(cache, addressSettings, workerShares);
    await (service as any).flushAddressTotals();

    expect(addressSettings.addSharesBulk).not.toHaveBeenCalled();
    expect(cache.confirmAddressFlush).not.toHaveBeenCalled();
  });

  it('flushAddressTotals: PG failure does NOT confirm — residual stays in cache', async () => {
    const drained = new Map<string, number>([['addr1', 10]]);
    const cache = {
      drainAddressDeltas: jest.fn().mockReturnValue(drained),
      drainWorkerDeltas: jest.fn().mockReturnValue([]),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    };
    const addressSettings = { addSharesBulk: jest.fn().mockRejectedValue(new Error('PG down')) };
    const workerShares = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };

    const service = buildServiceWithCache(cache, addressSettings, workerShares);
    await (service as any).flushAddressTotals();

    expect(addressSettings.addSharesBulk).toHaveBeenCalled();
    expect(cache.confirmAddressFlush).not.toHaveBeenCalled();
  });

  it('flushWorkerTotals: drains worker deltas, bulk-upserts, then confirms', async () => {
    const drained = [
      { address: 'addrA', clientName: 'rig1', shares: 12 },
      { address: 'addrB', clientName: 'rig2', shares: 7 },
    ];
    const cache = {
      drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
      drainWorkerDeltas: jest.fn().mockReturnValue(drained),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    };
    const addressSettings = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };
    const workerShares = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };

    const service = buildServiceWithCache(cache, addressSettings, workerShares);
    await (service as any).flushWorkerTotals();

    expect(workerShares.addSharesBulk).toHaveBeenCalledWith(drained);
    expect(cache.confirmWorkerFlush).toHaveBeenCalledWith(drained);
  });

  it('flushWorkerTotals: PG failure does NOT confirm', async () => {
    const drained = [{ address: 'addrA', clientName: 'rig1', shares: 12 }];
    const cache = {
      drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
      drainWorkerDeltas: jest.fn().mockReturnValue(drained),
      confirmAddressFlush: jest.fn(),
      confirmWorkerFlush: jest.fn(),
    };
    const addressSettings = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };
    const workerShares = { addSharesBulk: jest.fn().mockRejectedValue(new Error('PG down')) };

    const service = buildServiceWithCache(cache, addressSettings, workerShares);
    await (service as any).flushWorkerTotals();

    expect(cache.confirmWorkerFlush).not.toHaveBeenCalled();
  });
});
