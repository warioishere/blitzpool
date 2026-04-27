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
  // Hash store: key → { field → value }
  const hashes = new Map<string, Map<string, string>>();
  const getHash = (key: string) => {
    let h = hashes.get(key);
    if (!h) { h = new Map(); hashes.set(key, h); }
    return h;
  };

  return {
    incr: jest.fn(async (key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, val.toString());
      return val;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); hashes.delete(key); }),
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
    hGetAll: jest.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    hIncrByFloat: jest.fn(async (key: string, field: string, amount: number) => {
      const h = getHash(key);
      const cur = parseFloat(h.get(field) ?? '0') + amount;
      h.set(field, cur.toString());
      return cur;
    }),
    // Helpers for tests
    _getZset: () => zset,
    _getHash: (key: string) => hashes.get(key),
    _clear: () => { store.clear(); zset = []; hashes.clear(); },
  };
}

// ── Mock Balance backing (service + repo over shared store) ──────
// The service methods are what PplnsService calls outside transactions;
// the repo methods are what `em.getRepository(PplnsBalanceEntity)`
// returns inside the onBlockFound transaction. Both must see the same
// state, so we back them with one Map.

function createMockBalanceBacking() {
  const balances = new Map<string, { address: string; balanceSats: number; totalPaidSats: number }>();

  const service = {
    addPending: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) {
        existing.balanceSats += sats;
      } else {
        balances.set(address, { address, balanceSats: sats, totalPaidSats: 0 });
      }
    }),
    getBalanceSats: jest.fn(async (address: string) => balances.get(address)?.balanceSats ?? 0),
    getBalance: jest.fn(async (address: string) => balances.get(address) ?? null),
    getAllWithBalance: jest.fn(async () =>
      Array.from(balances.values()).filter(b => b.balanceSats !== 0),
    ),
    markPaid: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) {
        existing.balanceSats = Math.max(0, existing.balanceSats - sats);
        existing.totalPaidSats += sats;
      }
    }),
    touchLastAcceptedShareAt: jest.fn(async () => undefined),
    // Helpers
    _set: (address: string, balanceSats: number, totalPaidSats = 0) => {
      balances.set(address, { address, balanceSats, totalPaidSats });
    },
    _get: (address: string) => balances.get(address),
  };

  const applySave = (row: any) => {
    const existing = balances.get(row.address);
    if (existing) Object.assign(existing, row);
    else balances.set(row.address, { address: row.address, balanceSats: row.balanceSats ?? 0, totalPaidSats: row.totalPaidSats ?? 0 });
    return row;
  };
  const repo: any = {
    findOneBy: jest.fn(async (where: any) => balances.get(where.address) ?? null),
    // save() accepts a single entity or an array — TypeORM supports both,
    // and PplnsService.onBlockFound now uses the array form for batching.
    save: jest.fn(async (rows: any) =>
      Array.isArray(rows) ? rows.map(applySave) : applySave(rows),
    ),
    create: jest.fn((partial: any) => ({ ...partial })),
    find: jest.fn(async (q?: any) => {
      // Support `{ where: { address: In([...]) } }`. TypeORM's In() returns
      // a FindOperator object; to keep the mock decoupled from TypeORM
      // internals we sniff for `_value` which is where the IN-list lives.
      const inOp = q?.where?.address;
      if (inOp && typeof inOp === 'object' && Array.isArray(inOp._value)) {
        const set = new Set<string>(inOp._value);
        return Array.from(balances.values()).filter(b => set.has(b.address));
      }
      if (q?.where?.balanceSats) {
        return Array.from(balances.values()).filter(b => b.balanceSats !== 0);
      }
      return Array.from(balances.values());
    }),
  };

  return { service, repo };
}

// ── Mock Payout History Repo ────────────────────────────────────

function createMockPayoutHistoryRepo() {
  const saved: any[] = [];
  return {
    create: jest.fn((data: any) => data),
    save: jest.fn(async (entity: any) => {
      if (Array.isArray(entity)) { saved.push(...entity); return entity; }
      saved.push(entity); return entity;
    }),
    // Batch INSERT path used by the new onBlockFound code.
    insert: jest.fn(async (rows: any) => {
      if (Array.isArray(rows)) saved.push(...rows); else saved.push(rows);
      return { identifiers: [] };
    }),
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

      await service.recordShare('bc1qminera', 500);
      await service.recordShare('bc1qminerb', 300);

      const entries = await redis.zRange('pplns:shares', 0, -1);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('bc1qminera:500:');
      expect(entries[1]).toContain('bc1qminerb:300:');
    });

    // Regression for H1: bech32 input must be normalised to lowercase
    // before it reaches Redis, otherwise the same logical address
    // submitted in different casings would fragment the window.
    it('normalises mixed-case bech32 input (H1)', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(1000);

      await service.recordShare('BC1QMINERA', 500);
      await service.recordShare('bc1qMinerA', 250);

      const entries = await redis.zRange('pplns:shares', 0, -1);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('bc1qminera:500:');
      expect(entries[1]).toContain('bc1qminera:250:');

      const hash = await redis.hGetAll('pplns:window:by-address');
      expect(parseFloat(hash['bc1qminera'] ?? '0')).toBeCloseTo(750);
      expect(hash['BC1QMINERA']).toBeUndefined();
    });

    it('should update the window total', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(100000);

      await service.recordShare('bc1qminera', 500);
      await service.recordShare('bc1qminerb', 300);

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

  // ── Deployment migration ─────────────────────────────────────

  describe('deployment-migration: aggregate bootstrap', () => {
    it('onModuleInit rebuilds the aggregate from raw shares when hash is empty', async () => {
      // Simulate a pre-aggregate-rollout Redis: raw sorted set has
      // shares, hash doesn't exist. Without the bootstrap rebuild, the
      // first getPayoutDistribution after deploy would treat the empty
      // hash as "current window has no miners" — silently excluding
      // every pre-deploy miner. bootstrap check must populate the hash.
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);

      // Seed the raw set directly, bypassing recordShare (so the hash
      // stays empty, matching a pre-deploy Redis state).
      await redis.zAdd('pplns:shares', { score: 1, value: 'bc1qa:100:1000' });
      await redis.zAdd('pplns:shares', { score: 2, value: 'bc1qb:200:2000' });
      await redis.zAdd('pplns:shares', { score: 3, value: 'bc1qa:50:3000' });
      expect(redis._getHash('pplns:window:by-address')).toBeUndefined();

      // Trigger onModuleInit explicitly. The existing createService
      // bypasses it by manually wiring redis, so call it ourselves to
      // exercise the bootstrap path.
      await (service as any).onModuleInit();

      const hash = redis._getHash('pplns:window:by-address');
      expect(hash).toBeDefined();
      // A had 100 + 50 = 150; B had 200.
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(150);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(200);

      // And getPayoutDistribution now sees both miners (would have
      // silently excluded them pre-fix).
      const dist = await service.getPayoutDistribution(100_000_000);
      expect(dist.find(d => d.address === 'bc1qa')).toBeDefined();
      expect(dist.find(d => d.address === 'bc1qb')).toBeDefined();
    });

    it('onModuleInit is a no-op when hash already matches (warm restart)', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);

      // Normal state: shares flow through recordShare, hash stays in
      // sync. A restart where both exist should just leave it alone.
      await service.recordShare('bc1qa', 100);
      await service.recordShare('bc1qb', 200);
      const before = { ...redis._getHash('pplns:window:by-address')! };

      await (service as any).onModuleInit();

      const after = redis._getHash('pplns:window:by-address')!;
      expect(parseFloat(after.get('bc1qa') ?? '0')).toBeCloseTo(100);
      expect(parseFloat(after.get('bc1qb') ?? '0')).toBeCloseTo(200);
    });
  });

  // ── Window-by-Address Aggregate ──────────────────────────────

  describe('window aggregate (pplns:window:by-address)', () => {
    it('recordShare increments the aggregate per address', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 100 },
        { address: 'bc1qa', difficulty: 50 },
        { address: 'bc1qb', difficulty: 200 },
      ]);

      const hash = redis._getHash('pplns:window:by-address');
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(150);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(200);
    });

    it('trimWindow decrements the aggregate for removed shares', async () => {
      const { service, redis } = createService();
      // Small window so trim actually fires.
      service.setNetworkDifficulty(10);

      // Fill >> windowSize (4 * 10 = 40) so trim is forced.
      for (let i = 0; i < 150; i++) {
        await service.recordShare('bc1qa', 1);
      }

      const hash = redis._getHash('pplns:window:by-address');
      // After trim the aggregate for bc1qa should equal the total of
      // entries still in the window — NOT 150 (untrimmed total). Upper
      // bound is windowSize + one batch's worth of residual (trim
      // condition is `total > windowSize`, not `<=`).
      const aggA = parseFloat(hash!.get('bc1qa') ?? '0');
      expect(aggA).toBeLessThanOrEqual(100);
      expect(aggA).toBeGreaterThan(0);

      // And the aggregate must match the actual current window contents.
      const entries = await redis.zRange('pplns:shares', 0, -1);
      const expected = entries.reduce((s: number, e: string) =>
        s + (parseFloat(e.split(':')[1]) || 0), 0);
      expect(aggA).toBeCloseTo(expected);
    });

    it('getPayoutDistribution reads the aggregate (not the raw zset)', async () => {
      // Prove the hot-path is O(distinct miners), not O(shares): stuff
      // many shares per miner and verify the distribution comes out
      // exactly right (same result as if we scanned the whole zset).
      const { service, redis } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(10_000_000);

      for (let i = 0; i < 50; i++) await service.recordShare('bc1qa', 2);
      for (let i = 0; i < 30; i++) await service.recordShare('bc1qb', 1);

      const dist = await service.getPayoutDistribution(100_000_000);
      const a = dist.find(d => d.address === 'bc1qa');
      const b = dist.find(d => d.address === 'bc1qb');
      // A contributes 100 units, B 30; miner cut split 100:30.
      expect(a!.percent).toBeGreaterThan(b!.percent);

      // And the aggregate hash is the single source we read — clear the
      // raw zset and the distribution still works.
      const dist2 = await service.getPayoutDistribution(100_000_001); // miss cache
      expect(dist2.find(d => d.address === 'bc1qa')).toBeDefined();
      expect(dist2.find(d => d.address === 'bc1qb')).toBeDefined();
    });
  });

  // ── Payout Distribution ──────────────────────────────────────

  describe('getPayoutDistribution', () => {
    const BLOCK_REWARD = 312_500_000; // 3.125 BTC

    it('should distribute proportionally with pool fee', async () => {
      const { service } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 300 },
        { address: 'bc1qc', difficulty: 200 },
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
      const minerA = dist.find(d => d.address === 'bc1qa');
      const minerB = dist.find(d => d.address === 'bc1qb');
      expect(minerA!.percent).toBeGreaterThan(minerB!.percent);
    });

    it('should calculate correct sat amounts from percentages', async () => {
      const { service } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // 50/50 split
      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 500 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerA = dist.find(d => d.address === 'bc1qa')!;
      const minerB = dist.find(d => d.address === 'bc1qb')!;

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
        { address: 'bc1qa', difficulty: 10_000_000 },
        { address: 'bc1qb', difficulty: 1 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerB = dist.find(d => d.address === 'bc1qb');
      expect(minerB).toBeUndefined(); // Not in coinbase — sub-dust
    });

    it('should include pending balance in payout calculation', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner B has small shares but large pending
      balanceService._set('bc1qb', 100_000); // 100k sats pending

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 900 },
        { address: 'bc1qb', difficulty: 100 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerB = dist.find(d => d.address === 'bc1qb');
      expect(minerB).toBeDefined(); // Should be in coinbase (pending + base > dust)
    });

    it('should include pending-only addresses above the operational floor', async () => {
      // Pool-neutral: C has +6000 credit, A has matching -6000 debit
      // (the signed-ledger model requires a counterparty for credits).
      // Value is above the default operational floor (5 000 sats), so
      // C's pending becomes a coinbase output this block.
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      balanceService._set('bc1qc', 6000);    // credit, above PPLNS_MIN_PAYOUT_SATS default
      balanceService._set('bc1qa', -6000);   // matching debit, active miner

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
      ]);

      const dist = await service.getPayoutDistribution(BLOCK_REWARD);
      const minerC = dist.find(d => d.address === 'bc1qc');
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
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 500 },
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
      // Pool-neutral: A has +5000 credit, B has matching -5000 debit.
      // After the block, A's credit pays out via B's reduced rawFair.
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      balanceService._set('bc1qa', 5000);     // credit
      balanceService._set('bc1qb', -5000);    // matching debit

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // A's credit cleared; totalPaidSats reflects A's actual on-chain payout,
      // which is rawFair + credit.
      const balA = balanceService._get('bc1qa');
      expect(balA!.balanceSats).toBe(0);
      expect(balA!.totalPaidSats).toBeGreaterThanOrEqual(5000);
      // B's debit also cleared via reduced rawFair.
      const balB = balanceService._get('bc1qb');
      expect(balB!.balanceSats).toBe(0);
    });

    it('should accumulate pending for sub-dust miners', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      // Large window to avoid trimming
      service.setNetworkDifficulty(10_000_000);

      // ratio = 1/10_000_001 ≈ 1e-7, baseSats = floor(1e-7 * 306_250_000) = 30
      await recordShares(service, [
        { address: 'bc1qbig', difficulty: 10_000_000 },
        { address: 'bc1qtiny', difficulty: 1 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // 30 sats < 546 → Tiny goes to pending. onBlockFound now writes
      // through the transactional balance-repo path, so we verify the
      // shared backing store rather than the legacy service-facade spy.
      const balTiny = balanceService._get('bc1qtiny');
      expect(balTiny).toBeDefined();
      expect(balTiny!.balanceSats).toBeGreaterThan(0);
      expect(balTiny!.totalPaidSats).toBe(0);
    });

    it('should process pending-only addresses above operational floor', async () => {
      // Pool-neutral: C has +6000 pending (no shares), A has -6000 matching debit.
      // 6 000 sats is above the default PPLNS_MIN_PAYOUT_SATS (5 000),
      // so C's pending becomes an actual coinbase output here.
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      balanceService._set('bc1qc', 6000);     // pending-only credit, above floor
      balanceService._set('bc1qa', -6000);    // matching debit, active

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // C's credit paid out, balance cleared.
      const balC = balanceService._get('bc1qc');
      expect(balC!.balanceSats).toBe(0);
      expect(balC!.totalPaidSats).toBe(6000);
      // A's debit cleared via reduced rawFair.
      const balA = balanceService._get('bc1qa');
      expect(balA!.balanceSats).toBe(0);
    });

    it('should NOT process pending-only addresses below dust', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      // Miner C has pending below dust
      balanceService._set('bc1qc', 200); // < 546

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      // C's pending should remain untouched
      const balC = balanceService._get('bc1qc');
      expect(balC!.balanceSats).toBe(200);
      expect(balC!.totalPaidSats).toBe(0);
    });

    it('should log payout history for all miners including fee', async () => {
      const { service, payoutHistoryRepo } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 600 },
        { address: 'bc1qb', difficulty: 400 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);

      const history = payoutHistoryRepo._getSaved();
      // 2 miners + 1 fee = 3 entries
      expect(history.length).toBe(3);

      const feeEntry = history.find((h: any) => h.address === 'bc1qfee');
      expect(feeEntry).toBeDefined();
      expect(feeEntry.rowType).toBe('coinbase');
      expect(feeEntry.blockHeight).toBe(800000);
    });

    it('should handle accumulation across multiple blocks', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      // Large window to avoid trimming
      service.setNetworkDifficulty(10_000_000);

      // ratio = 1/10_000_001 → baseSats ≈ 30
      await recordShares(service, [
        { address: 'bc1qbig', difficulty: 10_000_000 },
        { address: 'bc1qsmall', difficulty: 1 },
      ]);

      await service.onBlockFound(800000, BLOCK_REWARD);
      const afterBlock1 = balanceService._get('bc1qsmall')?.balanceSats ?? 0;
      expect(afterBlock1).toBeGreaterThan(0);

      // Block 2: accumulate more (same window shares)
      await service.onBlockFound(800001, BLOCK_REWARD);
      const afterBlock2 = balanceService._get('bc1qsmall')?.balanceSats ?? 0;
      expect(afterBlock2).toBeGreaterThan(afterBlock1);
    });

    it('snapshot reward mismatch → falls back to window recalc instead of booking against wrong job', async () => {
      // If coinbasevalue changes between the job whose snapshot got
      // written and the job whose block was actually found (mempool
      // churn between two concurrent jobs), the snapshot's distribution
      // was computed for the wrong reward. Using it for bookkeeping
      // would drift pool accounting from on-chain reality. The defensive
      // check must detect and fall back.
      const { service, payoutHistoryRepo } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100_000);

      // Build snapshot at reward R1.
      const R1 = 100_000_000;
      await service.recordShare('bc1qalice', 1000);
      await service.getPayoutDistribution(R1);

      // Block is found at a different reward R2 (mempool churned).
      const R2 = 120_000_000;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await service.onBlockFound(800000, R2);
      } finally {
        warnSpy.mockRestore();
      }

      // History rows must be based on R2 (fallback path), not R1.
      // Concretely: Alice's history row paidSats should reflect R2's
      // rewardForMiners, not R1's. With one miner getting 100%, her
      // paidSats ≈ 0.98 * R2 = 117_600_000, not 0.98 * R1 = 98_000_000.
      const history = payoutHistoryRepo._getSaved() as any[];
      const aliceRow = history.find(r => r.address === 'bc1qalice' && r.rowType === 'coinbase');
      expect(aliceRow).toBeDefined();
      expect(aliceRow.paidSats).toBeGreaterThan(100_000_000);
    });

    it('late-arriving shares (post-snapshot) are logged but NOT credited to pending — prevents double-counting', async () => {
      // Scenario: pool builds a job, snapshot captures only Alice (Bob had no shares yet).
      // Between snapshot-build and block-found, Bob submits shares.
      // Alice then finds the block. The coinbase pays Alice via the snapshot.
      // Bob's shares arrived too late for THIS block's coinbase. In PPLNS, the
      // sliding window is NOT cleared, so Bob's shares remain in the window
      // and will be paid via the NEXT block's snapshot. Crediting Bob to
      // pending here would double-pay him — same class of bug group-solo
      // fixed in commit 6ace1b8, patched here for PPLNS too.
      const { service, balanceService, payoutHistoryRepo } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100_000);

      // Stage 1: only Alice has shares. Build snapshot.
      await service.recordShare('bc1qalice', 1000);
      await service.getPayoutDistribution(BLOCK_REWARD);

      // Stage 2: Bob arrives AFTER snapshot was built.
      await service.recordShare('bc1qbob', 2000);

      // Stage 3: Alice finds the block. Snapshot-based bookkeeping runs.
      await service.onBlockFound(800000, BLOCK_REWARD);

      // Bob's balance must NOT have been credited anything — the coinbase
      // already claimed 100% of the miner cut via Alice's snapshot entry,
      // and Bob's shares stay in the window for the next block's snapshot.
      const bobBalance = balanceService._get('bc1qbob');
      expect(bobBalance?.balanceSats ?? 0).toBe(0);

      // But Bob should have an audit history row with paidSats=0 so his
      // submitted shares are visible in the ledger.
      const history = payoutHistoryRepo._getSaved() as any[];
      const bobRows = history.filter(r => r.address === 'bc1qbob');
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0].paidSats).toBe(0);
      expect(bobRows[0].rowType).toBe('pending');
      expect(bobRows[0].rowType).toBe('pending');

      // Miner-cut coinbase total (excluding fee) must not exceed rewardForMiners.
      const rewardForMiners = Math.floor(0.98 * BLOCK_REWARD);
      const minerCoinbasePaid = history
        .filter(r => r.rowType === 'coinbase' && r.address !== 'bc1qfee')
        .reduce((sum, r) => sum + r.paidSats, 0);
      expect(minerCoinbasePaid).toBeLessThanOrEqual(rewardForMiners);
    });
  });

  // ── Window Stats ──────────────────────────────────────────────

  describe('getWindowStats', () => {
    it('should return correct stats', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(1000); // window = 4000

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 300 },
        { address: 'bc1qa', difficulty: 200 }, // A again
      ]);

      const stats = await service.getWindowStats();
      expect(stats.minerCount).toBe(2); // A and B
      expect(stats.totalShares).toBe(1000);
      expect(stats.windowSize).toBe(4000);
    });
  });

  // ── Address Status ────────────────────────────────────────────

  describe('getAddressStatus', () => {
    it('should return window share and pending balance', async () => {
      const { service, balanceService } = createService();
      service.setNetworkDifficulty(100000);
      balanceService._set('bc1qa', 5000, 50000);

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 600 },
        { address: 'bc1qb', difficulty: 400 },
      ]);

      const status = await service.getAddressStatus('bc1qa');
      expect(status.balanceSats).toBe(5000);
      expect(status.totalPaidSats).toBe(50000);
      expect(status.currentWindowShares).toBe(600);
      expect(status.currentWindowPercent).toBeCloseTo(60, 0);
    });

    it('should return zeros for unknown address', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(100000);

      const status = await service.getAddressStatus('bc1qunknown');
      expect(status.balanceSats).toBe(0);
      expect(status.totalPaidSats).toBe(0);
      expect(status.currentWindowShares).toBe(0);
      expect(status.currentWindowPercent).toBe(0);
    });
  });

  // ── Current Distribution ──────────────────────────────────────

  describe('getCurrentDistribution', () => {
    it('should return sorted distribution', async () => {
      const { service } = createService();
      service.setNetworkDifficulty(100000);

      await recordShares(service, [
        { address: 'bc1qa', difficulty: 100 },
        { address: 'bc1qb', difficulty: 300 },
        { address: 'bc1qc', difficulty: 600 },
      ]);

      const dist = await service.getCurrentDistribution();
      expect(dist).toHaveLength(3);
      // Sorted by percent descending
      expect(dist[0].address).toBe('bc1qc');
      expect(dist[0].percent).toBeCloseTo(60, 0);
      expect(dist[1].address).toBe('bc1qb');
      expect(dist[2].address).toBe('bc1qa');
    });
  });

  // ── Disabled Service ──────────────────────────────────────────

  describe('disabled state', () => {
    it('should not record shares when disabled', async () => {
      const { service, redis } = createService({ port: '' });
      (service as any).enabled = false;

      await service.recordShare('bc1qa', 500);
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
      // Budget sized for exactly 3 miner outputs under the current
      // constants (base 328 WU post-varint-fix, commitment 188,
      // output 172, fee output 172) + BUDGET_SAFETY_MARGIN_WU=200
      // held back from the effective cap by the adaptive trim:
      //   (B − 328 − 188 − 172 − 200) / 172 = 3  →  B = 3·172 + 688 + 200 = 1404
      // We use 1408 as a small safety headroom above the exact cutoff.
      const { service } = createService({ weightBudget: '1408' });
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
      // Budget for exactly 3 miner outputs — same math as the previous
      // test (1404 + 4 WU headroom = 1408 with BUDGET_SAFETY_MARGIN_WU=200).
      const { service } = createService({ weightBudget: '1408' });
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
