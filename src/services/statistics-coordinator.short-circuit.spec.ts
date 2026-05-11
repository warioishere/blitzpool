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

describe('StatisticsCoordinator — Tier A: slot-aware short-circuit (Redis-flushers only)', () => {
  // pool-mode-hashrate and pool-share-statistics moved to in-memory accumulators
  // (Phase B). The remaining three Redis-backed flushers (clientStatistics,
  // poolRejectedStatistics, clientRejectedStatistics) still use the SCAN+HGETALL
  // pattern and respect the slot-short-circuit. Tests here pin that behaviour
  // for those flushers using flushClientStatistics as the representative.
  let originalSlotFn: any;
  let mockSlot: number;

  beforeEach(() => {
    mockSlot = 1700000000000;
    originalSlotFn = TimeSlotHelper.getCurrentSlot;
    (TimeSlotHelper as any).getCurrentSlot = () => mockSlot;
  });

  afterEach(() => {
    (TimeSlotHelper as any).getCurrentSlot = originalSlotFn;
  });

  it('flushClientStatistics: first call does SCAN, subsequent calls within same slot do NOT', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    await (service as any).flushClientStatistics();
    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it('flushClientStatistics: slot transition triggers scan again', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    mockSlot += 600_000;
    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
  });

  it('the 3 still-Redis flushers short-circuit independently after their own first tick', async () => {
    // pool-mode-hashrate and pool-share-statistics moved off Redis (Phase B).
    // The remaining three respect the slot-short-circuit.
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushPoolShares();          // in-memory, no scan
    await (service as any).flushPoolModeHashrate();    // in-memory, no scan
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(3);

    // Same slot: ALL skip SCAN.
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(3);

    mockSlot += 600_000;
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(6);  // 3 → 6
  });

  it('lastFlushedSlot is updated even when SCAN returns ZERO keys (no work case)', async () => {
    const mockRedis = makeMockRedis();
    mockRedis.scan.mockResolvedValue({ cursor: '0', keys: [] });
    const service = buildService(mockRedis);

    await (service as any).flushClientStatistics();
    expect((service as any).lastFlushedSlot.clientStatistics).toBe(mockSlot);

    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it('post-restart: lastFlushedSlot starts at -1, first call always scans', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    expect((service as any).lastFlushedSlot.clientStatistics).toBe(-1);

    await (service as any).flushClientStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
    expect((service as any).lastFlushedSlot.clientStatistics).toBe(mockSlot);
  });

  it('flushPoolShares / flushPoolModeHashrate: in-memory paths never scan Redis', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushPoolShares();
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushPoolModeHashrate();

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
