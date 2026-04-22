jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';

// ── Mock Redis ──────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();
  // Sorted set: array of { score, value } sorted by score
  let zset: { score: number; value: string }[] = [];

  return {
    incr: jest.fn(async (key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, val.toString());
      return val;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); }),
    expire: jest.fn(async (_key: string, _seconds: number) => 1),
    incrByFloat: jest.fn(async (key: string, amount: number) => {
      const val = parseFloat(store.get(key) ?? '0') + amount;
      store.set(key, val.toString());
      return val;
    }),
    zAdd: jest.fn(async (_key: string, entry: { score: number; value: string }) => {
      zset.push(entry);
      zset.sort((a, b) => a.score - b.score);
    }),
    zRange: jest.fn(async (_key: string, start: number, end: number) => {
      if (end === -1) end = zset.length - 1;
      return zset.slice(start, end + 1).map(e => e.value);
    }),
    zRemRangeByRank: jest.fn(async (_key: string, start: number, end: number) => {
      zset.splice(start, end - start + 1);
    }),
    zCard: jest.fn(async () => zset.length),
    // Helpers for tests
    _getZset: () => zset,
    _clear: () => { store.clear(); zset = []; },
  };
}

// ── Mock Balance backing (service + repo over shared store) ──────
// The service methods are what PplnsService calls outside transactions;
// the repo methods are what `em.getRepository(PplnsBalanceEntity)`
// returns inside the onBlockFound transaction. Both must see the same
// state, so we back them with one Map.

function createMockBalanceBacking() {
  const balances = new Map<string, { address: string; pendingSats: number; totalPaidSats: number }>();

  const service = {
    addPending: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) {
        existing.pendingSats += sats;
      } else {
        balances.set(address, { address, pendingSats: sats, totalPaidSats: 0 });
      }
    }),
    getPending: jest.fn(async (address: string) => balances.get(address)?.pendingSats ?? 0),
    getBalance: jest.fn(async (address: string) => balances.get(address) ?? null),
    getAllWithPending: jest.fn(async () =>
      Array.from(balances.values()).filter(b => b.pendingSats > 0),
    ),
    markPaid: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) {
        existing.pendingSats = Math.max(0, existing.pendingSats - sats);
        existing.totalPaidSats += sats;
      }
    }),
    // Helpers
    _set: (address: string, pendingSats: number, totalPaidSats = 0) => {
      balances.set(address, { address, pendingSats, totalPaidSats });
    },
    _get: (address: string) => balances.get(address),
  };

  const repo: any = {
    findOneBy: jest.fn(async (where: any) => balances.get(where.address) ?? null),
    save: jest.fn(async (row: any) => {
      const existing = balances.get(row.address);
      if (existing) Object.assign(existing, row);
      else balances.set(row.address, { address: row.address, pendingSats: row.pendingSats ?? 0, totalPaidSats: row.totalPaidSats ?? 0 });
      return row;
    }),
    create: jest.fn((partial: any) => ({ ...partial })),
    find: jest.fn(async (q?: any) =>
      q?.where?.pendingSats
        ? Array.from(balances.values()).filter(b => b.pendingSats > 0)
        : Array.from(balances.values()),
    ),
  };

  return { service, repo };
}

// ── Mock Payout History Repo ────────────────────────────────────

function createMockPayoutHistoryRepo() {
  const saved: any[] = [];
  return {
    create: jest.fn((data: any) => data),
    save: jest.fn(async (entity: any) => { saved.push(entity); return entity; }),
    find: jest.fn(async () => saved),
    findOneBy: jest.fn(async (where: any) =>
      saved.find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    _getSaved: () => saved,
  };
}

// ── Service Factory ─────────────────────────────────────────────

function createService(opts: { feeAddress?: string; feePercent?: string; port?: string; weightBudget?: string } = {}) {
  const redis = createMockRedis();
  const balanceBacking = createMockBalanceBacking();
  const balanceService = balanceBacking.service;
  const payoutHistoryRepo = createMockPayoutHistoryRepo();
  attachMockTxManager([
    [PplnsPayoutHistoryEntity, payoutHistoryRepo],
    [PplnsBalanceEntity, balanceBacking.repo],
  ]);

  const configService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        PPLNS_FEE_ADDRESS: opts.feeAddress ?? 'bc1qfee',
        PPLNS_FEE_PERCENT: opts.feePercent ?? '2',
        PPLNS_PORT: opts.port ?? '3340',
        ...(opts.weightBudget ? { PPLNS_COINBASE_WEIGHT_BUDGET: opts.weightBudget } : {}),
      };
      return config[key];
    }),
  };

  const cacheManager = { store: { client: redis } };

  const stratumV1JobsService = {
    newMiningJob$: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  };

  const service = new PplnsService(
    configService as any,
    cacheManager as any,
    balanceService as any,
    payoutHistoryRepo as any,
    stratumV1JobsService as any,
  );

  // Manually trigger onModuleInit to wire up Redis
  (service as any).redis = redis;
  (service as any).enabled = true;

  return { service, redis, balanceService, payoutHistoryRepo };
}

// ── Helper: record N shares ─────────────────────────────────────

async function recordShares(
  service: PplnsService,
  shares: { address: string; difficulty: number }[],
) {
  for (const s of shares) {
    await service.recordShare(s.address, s.difficulty);
  }
}

// ═════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════

describe('PplnsService', () => {
  // ── Share Recording ──────────────────────────────────────────

  describe('recordShare', () => {
    it('should add shares to the Redis sorted set', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(1000);

      await service.recordShare('bc1qminerA', 500);
      await service.recordShare('bc1qminerB', 300);

      const entries = await redis.zRange('pplns:shares', 0, -1);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('bc1qminerA:500:');
      expect(entries[1]).toContain('bc1qminerB:300:');
    });

    it('should update the window total', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(100000);

      await service.recordShare('bc1qminerA', 500);
      await service.recordShare('bc1qminerB', 300);

      const total = parseFloat(await redis.get('pplns:window:total') ?? '0');
      expect(total).toBe(800);
    });
  });

  // ── Window Trimming ──────────────────────────────────────────

  describe('trimWindow', () => {
    it('should trim oldest shares when window exceeds N', async () => {
      const { service, redis } = createService();
      // Window size = 4 * 100 = 400
      service.setNetworkDifficulty(100);

      // Add 500 total difficulty (exceeds 400 window)
      await recordShares(service, [
        { address: 'A', difficulty: 100 },
        { address: 'B', difficulty: 100 },
        { address: 'C', difficulty: 100 },
        { address: 'D', difficulty: 100 },
        { address: 'E', difficulty: 100 },
      ]);

      // Oldest share(s) should have been trimmed
      const entries = await redis.zRange('pplns:shares', 0, -1);
      const totalDiff = entries.reduce((sum: number, e: string) => sum + parseFloat(e.split(':')[1]), 0);
      expect(totalDiff).toBeLessThanOrEqual(400);
    });

    it('should keep window total in sync', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(100); // window = 400

      await recordShares(service, [
        { address: 'A', difficulty: 200 },
        { address: 'B', difficulty: 200 },
        { address: 'C', difficulty: 200 }, // total 600, exceeds 400
      ]);

      const stored = parseFloat(await redis.get('pplns:window:total') ?? '0');
      const entries = await redis.zRange('pplns:shares', 0, -1);
      const actual = entries.reduce((sum: number, e: string) => sum + parseFloat(e.split(':')[1]), 0);

      expect(Math.abs(stored - actual)).toBeLessThan(0.01);
    });

    it('should not trim when window is not full', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(1000); // window = 4000

      await recordShares(service, [
        { address: 'A', difficulty: 100 },
        { address: 'B', difficulty: 100 },
      ]);

      const entries = await redis.zRange('pplns:shares', 0, -1);
      expect(entries).toHaveLength(2);
    });
  });

  // ── Payout Distribution ──────────────────────────────────────

  describe('getPayoutDistribution', () => {
    const BLOCK_REWARD = 312_500_000; // 3.125 BTC

    it('should distribute proportionally with pool fee', async () => {
      const { service } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
        { address: 'bc1qB', difficulty: 300 },
        { address: 'bc1qC', difficulty: 200 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);

      // Fee should be first
      expect(dist[0].address).toBe('bc1qfee');

      // Sum should be ~100%
      const totalPercent = dist.reduce((s, d) => s + d.percent, 0);
      expect(totalPercent).toBeCloseTo(100, 1);

      // Fee should be ~2%
      expect(dist[0].percent).toBeCloseTo(2, 0);

      // Miner A should have highest share
      const minerA = dist.find(d => d.address === 'bc1qA');
      const minerB = dist.find(d => d.address === 'bc1qB');
      expect(minerA!.percent).toBeGreaterThan(minerB!.percent);
    });

    it('should calculate correct sat amounts from percentages', async () => {
      const { service } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // 50/50 split
      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
        { address: 'bc1qB', difficulty: 500 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerA = dist.find(d => d.address === 'bc1qA')!;
      const minerB = dist.find(d => d.address === 'bc1qB')!;

      // Each miner should get 49% (half of 98%)
      expect(minerA.percent).toBeCloseTo(49, 0);
      expect(minerB.percent).toBeCloseTo(49, 0);

      // Sat calculation: floor(0.49 * 312_500_000) = 153_125_000
      const satA = Math.floor((minerA.percent / 100) * BLOCK_REWARD);
      expect(satA).toBeGreaterThan(150_000_000);
    });

    it('should filter sub-dust miners from coinbase', async () => {
      const { service } = createService({ feePercent: '2' });
      // Set window large enough to hold all shares without trimming
      service.setNetworkDifficulty(10_000_000);

      // Miner B has negligible shares → sub-dust
      // ratio = 1/10_000_001 ≈ 1e-7, baseSats = floor(1e-7 * 306_250_000) = 30 < 546
      await recordShares(service, [
        { address: 'bc1qA', difficulty: 10_000_000 },
        { address: 'bc1qB', difficulty: 1 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerB = dist.find(d => d.address === 'bc1qB');
      expect(minerB).toBeUndefined(); // Not in coinbase — sub-dust
    });

    it('should include pending balance in payout calculation', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner B has small shares but large pending
      balanceService._set('bc1qB', 100_000); // 100k sats pending

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 900 },
        { address: 'bc1qB', difficulty: 100 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerB = dist.find(d => d.address === 'bc1qB');
      expect(minerB).toBeDefined(); // Should be in coinbase (pending + base > dust)
    });

    it('should include pending-only addresses above dust', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner C has no current shares but enough pending
      balanceService._set('bc1qC', 1000); // 1000 sats pending >= 546

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerC = dist.find(d => d.address === 'bc1qC');
      expect(minerC).toBeDefined();
    });

    it('should return fallback when window is empty', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(100000);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      expect(dist).toHaveLength(1);
      expect(dist[0].address).toBe('bc1qfee');
      expect(dist[0].percent).toBe(100);
    });

    it('should assign remainder percent to fee address', async () => {
      const { service } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Two miners, one gets filtered as sub-dust
      // The sub-dust miner's share goes to fee as remainder
      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
        { address: 'bc1qB', difficulty: 500 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const totalPercent = dist.reduce((s, d) => s + d.percent, 0);
      // Remainder mechanism ensures total is 100%
      expect(totalPercent).toBeCloseTo(100, 1);

      // Fee should be at least 2%
      const fee = dist.find(d => d.address === 'bc1qfee');
      expect(fee).toBeDefined();
      expect(fee!.percent).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Block Found ──────────────────────────────────────────────

  describe('onBlockFound', () => {
    const BLOCK_REWARD = 312_500_000;

    it('should mark pending as paid for above-dust miners', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      balanceService._set('bc1qA', 5000); // 5000 sats pending

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
        { address: 'bc1qB', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // A's pending should be cleared
      const balA = balanceService._get('bc1qA');
      expect(balA!.pendingSats).toBe(0);
      expect(balA!.totalPaidSats).toBe(5000);
    });

    it('should accumulate pending for sub-dust miners', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      // Large window to avoid trimming
      service.setNetworkDifficulty(10_000_000);

      // ratio = 1/10_000_001 ≈ 1e-7, baseSats = floor(1e-7 * 306_250_000) = 30
      await recordShares(service, [
        { address: 'bc1qBig', difficulty: 10_000_000 },
        { address: 'bc1qTiny', difficulty: 1 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // 30 sats < 546 → Tiny goes to pending. onBlockFound now writes
      // through the transactional balance-repo path, so we verify the
      // shared backing store rather than the legacy service-facade spy.
      const balTiny = balanceService._get('bc1qTiny');
      expect(balTiny).toBeDefined();
      expect(balTiny!.pendingSats).toBeGreaterThan(0);
      expect(balTiny!.totalPaidSats).toBe(0);
    });

    it('should process pending-only addresses', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner C has pending from previous blocks but no current shares
      balanceService._set('bc1qC', 1000);

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // C's pending should be marked as paid (>= 546 dust)
      const balC = balanceService._get('bc1qC');
      expect(balC!.pendingSats).toBe(0);
      expect(balC!.totalPaidSats).toBe(1000);
    });

    it('should NOT process pending-only addresses below dust', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner C has pending below dust
      balanceService._set('bc1qC', 200); // < 546

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // C's pending should remain untouched
      const balC = balanceService._get('bc1qC');
      expect(balC!.pendingSats).toBe(200);
      expect(balC!.totalPaidSats).toBe(0);
    });

    it('should log payout history for all miners including fee', async () => {
      const { service, payoutHistoryRepo } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 600 },
        { address: 'bc1qB', difficulty: 400 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      const history = payoutHistoryRepo._getSaved();
      // 2 miners + 1 fee = 3 entries
      expect(history.length).toBe(3);

      const feeEntry = history.find((h: any) => h.address === 'bc1qfee');
      expect(feeEntry).toBeDefined();
      expect(feeEntry.inCoinbase).toBe(true);
      expect(feeEntry.blockHeight).toBe(800000);
    });

    it('should handle accumulation across multiple blocks', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      // Large window to avoid trimming
      service.setNetworkDifficulty(10_000_000);

      // ratio = 1/10_000_001 → baseSats ≈ 30
      await recordShares(service, [
        { address: 'bc1qBig', difficulty: 10_000_000 },
        { address: 'bc1qSmall', difficulty: 1 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);
      const afterBlock1 = balanceService._get('bc1qSmall')?.pendingSats ?? 0;
      expect(afterBlock1).toBeGreaterThan(0);

      // Block 2: accumulate more (same window shares)
      await service.onBlockFound(800001, BLOCK_REWARD);
      const afterBlock2 = balanceService._get('bc1qSmall')?.pendingSats ?? 0;
      expect(afterBlock2).toBeGreaterThan(afterBlock1);
    });
  });

  // ── Window Stats ──────────────────────────────────────────────

  describe('getWindowStats', () => {
    it('should return correct stats', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(1000); // window = 4000

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 500 },
        { address: 'bc1qB', difficulty: 300 },
        { address: 'bc1qA', difficulty: 200 }, // A again
      ]);

      const stats = await service.getWindowStats();
      expect(stats.shareCount).toBe(3);
      expect(stats.minerCount).toBe(2); // A and B
      expect(stats.totalDifficulty).toBe(1000);
      expect(stats.windowSize).toBe(4000);
    });
  });

  // ── Address Status ────────────────────────────────────────────

  describe('getAddressStatus', () => {
    it('should return window share and pending balance', async () => {
      const { service, balanceService } = createService();
      service.setNetworkDifficulty(100000);
      balanceService._set('bc1qA', 5000, 50000);

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 600 },
        { address: 'bc1qB', difficulty: 400 },
      ]);

      const status = await service.getAddressStatus('bc1qA');
      expect(status.pendingSats).toBe(5000);
      expect(status.totalPaidSats).toBe(50000);
      expect(status.currentWindowDifficulty).toBe(600);
      expect(status.currentWindowPercent).toBeCloseTo(60, 0);
    });

    it('should return zeros for unknown address', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(100000);

      const status = await service.getAddressStatus('bc1qUnknown');
      expect(status.pendingSats).toBe(0);
      expect(status.totalPaidSats).toBe(0);
      expect(status.currentWindowDifficulty).toBe(0);
      expect(status.currentWindowPercent).toBe(0);
    });
  });

  // ── Current Distribution ──────────────────────────────────────

  describe('getCurrentDistribution', () => {
    it('should return sorted distribution', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qA', difficulty: 100 },
        { address: 'bc1qB', difficulty: 300 },
        { address: 'bc1qC', difficulty: 600 },
      ]);

      const dist = await service.getCurrentDistribution();
      expect(dist).toHaveLength(3);
      // Sorted by percent descending
      expect(dist[0].address).toBe('bc1qC');
      expect(dist[0].percent).toBeCloseTo(60, 0);
      expect(dist[1].address).toBe('bc1qB');
      expect(dist[2].address).toBe('bc1qA');
    });
  });

  // ── Disabled Service ──────────────────────────────────────────

  describe('disabled state', () => {
    it('should not record shares when disabled', async () => {
      const { service, redis } = createService({ port: '' });
      (service as any).enabled = false;

      await service.recordShare('bc1qA', 500);
      expect(redis.zAdd).not.toHaveBeenCalled();
    });

    it('should return fallback distribution when disabled', async () => {
      const { service } = createService({ port: '' });
      (service as any).enabled = false;

      const dist = await service.getPayoutDistribution(312_500_000);
      expect(dist).toHaveLength(1);
      expect(dist[0].percent).toBe(100);
    });
  });

  // ── Coinbase Weight Validation ────────────────────────────────

  describe('coinbase weight validation', () => {
    const BLOCK_REWARD = 312_500_000;

    it('should report correct max outputs for default budget', () => {
      const { service } = createService();
      const max = service.getMaxCoinbaseOutputs();
      // New formula with P2TR-sized outputs (172 WU) + dedicated OP_RETURN (188 WU):
      // (50000 - 320 - 188 - 1*172) / 172 = floor(49320/172) = 286
      expect(max).toBeGreaterThan(250);
      expect(max).toBeLessThan(320);
    });

    it('should trim outputs when miners exceed weight budget', async () => {
      // Budget sized for exactly 3 miner outputs:
      // (B - 320 - 188 - 172) / 172 = 3  →  B = 3*172 + 680 = 1196
      const { service } = createService({ weightBudget: '1200' });
      service.setNetworkDifficulty(100_000_000); // large window

      // Add 10 miners with equal shares
      for (let i = 0; i < 10; i++) {
        await service.recordShare(`miner${i}`, 1000);
      }

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);

      // Should have: fee + max 3 miners = 4 outputs (not 11)
      const minerOutputs = dist.filter(d => d.address !== 'bc1qfee');
      expect(minerOutputs.length).toBeLessThanOrEqual(3);
      expect(dist.length).toBeLessThanOrEqual(4);

      // Percentages should still sum to ~100
      const totalPercent = dist.reduce((s, d) => s + d.percent, 0);
      expect(totalPercent).toBeCloseTo(100, 0);
    });

    it('should keep largest miners when trimming', async () => {
      // Budget for 3 miner outputs under the new P2TR constants.
      const { service } = createService({ weightBudget: '1200' });
      service.setNetworkDifficulty(100_000_000);

      // Miners with very different shares
      await service.recordShare('big1', 10000);
      await service.recordShare('big2', 8000);
      await service.recordShare('big3', 6000);
      await service.recordShare('small1', 100);
      await service.recordShare('small2', 50);
      await service.recordShare('small3', 10);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerAddrs = dist.filter(d => d.address !== 'bc1qfee').map(d => d.address);

      // Big miners should be in, small miners trimmed
      expect(minerAddrs).toContain('big1');
      expect(minerAddrs).toContain('big2');
      expect(minerAddrs).toContain('big3');
      expect(minerAddrs).not.toContain('small1');
      expect(minerAddrs).not.toContain('small2');
      expect(minerAddrs).not.toContain('small3');
    });

    it('should not trim when miners fit within budget', async () => {
      const { service } = createService(); // default 50000 budget, ~286 miner outputs
      service.setNetworkDifficulty(100_000_000);

      // 5 miners — well within budget
      for (let i = 0; i < 5; i++) {
        await service.recordShare(`miner${i}`, 1000);
      }

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerOutputs = dist.filter(d => d.address !== 'bc1qfee');
      expect(minerOutputs.length).toBe(5); // all 5 kept
    });

    it('should handle custom weight budget from env', () => {
      const { service } = createService({ weightBudget: '100000' });
      const max = service.getMaxCoinbaseOutputs();
      // (100000 - 320 - 188 - 172) / 172 = floor(99320/172) = 577
      expect(max).toBeGreaterThan(500);
      expect(max).toBeLessThan(650);
    });
  });
});
