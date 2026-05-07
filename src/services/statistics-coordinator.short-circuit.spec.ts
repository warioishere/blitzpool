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

describe('StatisticsCoordinator — Tier A: slot-aware short-circuit', () => {
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

  it('flushPoolShares: first call does SCAN, second call within same slot does NOT', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    // First tick: scan runs, finds nothing, marks slot processed
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    // Second tick within same slot: short-circuit, NO scan
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    // Third tick within same slot: still no scan
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it('flushPoolShares: slot transition triggers scan again', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    // Same slot: short-circuit
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);

    // Slot transitions
    mockSlot += 600_000;
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
  });

  it('all 5 slot-bound flushers short-circuit independently after their own first tick', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    // First flushAllStatistics-like call: each flusher scans once.
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(5);

    // Second pass within same slot: ALL skip SCAN.
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(5);  // unchanged

    // Slot transition: all 5 scan again on next call.
    mockSlot += 600_000;
    await (service as any).flushPoolShares();
    await (service as any).flushPoolModeHashrate();
    await (service as any).flushClientStatistics();
    await (service as any).flushPoolRejectedStatistics();
    await (service as any).flushClientRejectedStatistics();
    expect(mockRedis.scan).toHaveBeenCalledTimes(10);  // 5 → 10
  });

  it('lastFlushedSlot is updated even when SCAN returns ZERO keys (no work case)', async () => {
    const mockRedis = makeMockRedis();
    // SCAN returns empty
    mockRedis.scan.mockResolvedValue({ cursor: '0', keys: [] });
    const service = buildService(mockRedis);

    await (service as any).flushPoolShares();
    expect((service as any).lastFlushedSlot.poolShares).toBe(mockSlot);

    // Subsequent ticks: short-circuit, no additional SCAN
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it('post-restart: lastFlushedSlot starts at -1, first call always scans', async () => {
    const mockRedis = makeMockRedis();
    const service = buildService(mockRedis);

    // Verify default state
    expect((service as any).lastFlushedSlot.poolShares).toBe(-1);
    expect((service as any).lastFlushedSlot.clientStatistics).toBe(-1);

    // First tick: scans (because -1 !== currentSlot)
    await (service as any).flushPoolShares();
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
    expect((service as any).lastFlushedSlot.poolShares).toBe(mockSlot);
  });
});

describe('StatisticsCoordinator — Tier B: dirty-set for running totals', () => {
  it('flushAddressTotals: uses SMEMBERS instead of SCAN when dirty-set is populated', async () => {
    const mockRedis = makeMockRedis();
    mockRedis.sMembers.mockResolvedValue(['addr1', 'addr2', 'addr3']);
    // hGetAll returns 0-delta for all so we don't trip into the writeback path
    mockRedis.multi = jest.fn(function (this: any) {
      const ops: any[] = [];
      const chain: any = {
        hGetAll: (k: string) => { ops.push(k); return chain; },
        hIncrByFloat: () => chain,
        hSet: () => chain,
        // Return one entry per queued hGetAll, all empty
        exec: jest.fn().mockImplementation(async () => ops.map(() => ({}))),
      };
      return chain;
    });

    const service = buildService(mockRedis);
    await (service as any).flushAddressTotals();

    // SMEMBERS was called for the dirty-set
    expect(mockRedis.sMembers).toHaveBeenCalledWith('coord:dirty:addresses');
    // SCAN was NOT used as the fallback (set was non-empty)
    expect(mockRedis.scan).not.toHaveBeenCalled();
  });

  it('flushAddressTotals: bootstrap fallback SCANs when dirty-set is empty + populates the set', async () => {
    const mockRedis = makeMockRedis();
    // First sMembers returns empty, simulating fresh restart with no dirty-set yet
    mockRedis.sMembers.mockResolvedValue([]);
    // SCAN returns existing legacy address keys
    mockRedis.scan
      .mockResolvedValueOnce({ cursor: '0', keys: ['shares:address:legacy1', 'shares:address:legacy2'] });

    const service = buildService(mockRedis);
    await (service as any).flushAddressTotals();

    // SMEMBERS first
    expect(mockRedis.sMembers).toHaveBeenCalledWith('coord:dirty:addresses');
    // Fallback SCAN
    expect(mockRedis.scan).toHaveBeenCalled();
    // Dirty-set backfilled with the canonical entries
    expect(mockRedis.sAdd).toHaveBeenCalledWith(
      'coord:dirty:addresses',
      ['legacy1', 'legacy2'],
    );
  });

  it('flushWorkerTotals: SMEMBERS returns "{addr}|{worker}" entries, parses to data keys', async () => {
    const mockRedis = makeMockRedis();
    mockRedis.sMembers.mockResolvedValue(['addrA|rig1', 'addrB|rig2']);
    mockRedis.multi = jest.fn(function (this: any) {
      const ops: any[] = [];
      const chain: any = {
        hGetAll: (k: string) => { ops.push(k); return chain; },
        hIncrByFloat: () => chain,
        hSet: () => chain,
        exec: jest.fn().mockImplementation(async () => ops.map(() => ({}))),
      };
      return chain;
    });

    const service = buildService(mockRedis);
    await (service as any).flushWorkerTotals();

    expect(mockRedis.sMembers).toHaveBeenCalledWith('coord:dirty:workers');
    // No fallback SCAN — set was non-empty
    expect(mockRedis.scan).not.toHaveBeenCalled();
  });

  it('empty dirty-set + empty SCAN: flushers return immediately without errors', async () => {
    const mockRedis = makeMockRedis();
    mockRedis.sMembers.mockResolvedValue([]);
    mockRedis.scan.mockResolvedValue({ cursor: '0', keys: [] });

    const service = buildService(mockRedis);
    await expect((service as any).flushAddressTotals()).resolves.not.toThrow();
    await expect((service as any).flushWorkerTotals()).resolves.not.toThrow();
  });
});
