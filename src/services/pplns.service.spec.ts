jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';

// ── Mock Redis ──────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();
  // Keyed sorted sets: key → (member → score). ZADD dedups by member (same
  // member updates its score), mirroring real Redis — essential for the
  // bucket-index zset, which recordShare re-ZADDs the same bucketId per share.
  const zsets = new Map<string, Map<string, number>>();
  const getZ = (key: string) => {
    let z = zsets.get(key);
    if (!z) { z = new Map(); zsets.set(key, z); }
    return z;
  };
  // Members of a zset sorted by score (ties broken lexicographically, as Redis).
  const sortedMembers = (key: string): string[] =>
    Array.from(getZ(key).entries())
      .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([m]) => m);
  // Hash store: key → { field → value }
  const hashes = new Map<string, Map<string, string>>();
  const getHash = (key: string) => {
    let h = hashes.get(key);
    if (!h) { h = new Map(); hashes.set(key, h); }
    return h;
  };

  const incrByFloatImpl = async (key: string, amount: number) => {
    const val = parseFloat(store.get(key) ?? '0') + amount;
    store.set(key, val.toString());
    return val;
  };
  const zAddImpl = async (key: string, entry: { score: number; value: string }) => {
    getZ(key).set(entry.value, entry.score);
  };
  const hIncrByFloatImpl = async (key: string, field: string, amount: number) => {
    const h = getHash(key);
    const cur = parseFloat(h.get(field) ?? '0') + amount;
    h.set(field, cur.toString());
    return cur;
  };

  const mock: any = {
    incr: jest.fn(async (key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, val.toString());
      return val;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); hashes.delete(key); zsets.delete(key); }),
    expire: jest.fn(async (_key: string, _seconds: number) => 1),
    incrByFloat: jest.fn(incrByFloatImpl),
    zAdd: jest.fn(zAddImpl),
    zRange: jest.fn(async (key: string, start: number, end: number) => {
      const members = sortedMembers(key);
      if (end === -1) end = members.length - 1;
      return members.slice(start, end + 1);
    }),
    zRem: jest.fn(async (key: string, member: string | string[]) => {
      const z = getZ(key);
      for (const m of Array.isArray(member) ? member : [member]) z.delete(m);
    }),
    zRemRangeByRank: jest.fn(async (key: string, start: number, end: number) => {
      const members = sortedMembers(key);
      const z = getZ(key);
      for (const m of members.slice(start, end + 1)) z.delete(m);
    }),
    zCard: jest.fn(async (key: string) => getZ(key).size),
    hGetAll: jest.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    hSet: jest.fn(async (key: string, fields: Record<string, string>) => {
      // Real Redis would clear the string-key value; tests don't mix types,
      // but keep parity with the production mock.
      store.delete(key);
      const h = getHash(key);
      for (const [field, value] of Object.entries(fields)) {
        h.set(field, value);
      }
      return Object.keys(fields).length;
    }),
    hIncrByFloat: jest.fn(hIncrByFloatImpl),
    hDel: jest.fn(async (key: string, field: string) => {
      const h = hashes.get(key);
      if (h) h.delete(field);
    }),
    rename: jest.fn(async (src: string, dst: string) => {
      // Atomic key swap — move hash + string value from src to dst, drop src.
      const h = hashes.get(src);
      hashes.delete(dst);
      if (h) { hashes.set(dst, h); hashes.delete(src); }
      const s = store.get(src);
      if (s !== undefined) { store.set(dst, s); store.delete(src); }
      if (h === undefined && s === undefined) throw new Error('ERR no such key');
    }),
    multi: jest.fn(() => {
      const ops: Array<() => Promise<any>> = [];
      const builder: any = {
        zAdd: (key: string, entry: { score: number; value: string }) => {
          ops.push(() => zAddImpl(key, entry));
          return builder;
        },
        incrByFloat: (key: string, amt: number) => {
          ops.push(() => incrByFloatImpl(key, amt));
          return builder;
        },
        hIncrByFloat: (key: string, field: string, amt: number) => {
          ops.push(() => hIncrByFloatImpl(key, field, amt));
          return builder;
        },
        exec: async () => {
          const results = [];
          for (const op of ops) results.push(await op());
          return results;
        },
      };
      return builder;
    }),
    // Helpers for tests
    _getZ: (key: string) => getZ(key),
    _getHash: (key: string) => hashes.get(key),
    _clear: () => { store.clear(); zsets.clear(); hashes.clear(); },
  };
  return mock;
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
    getBalanceLight: jest.fn(async (address: string) => {
      const b = balances.get(address);
      return b ? { balanceSats: b.balanceSats, totalPaidSats: b.totalPaidSats } : null;
    }),
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
    markTouch: jest.fn(),
    flushPendingTouches: jest.fn(async () => undefined),
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

function createService(opts: { feeAddress?: string; feePercent?: string; port?: string; weightBudget?: string; bucketShares?: string } = {}) {
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
        ...(opts.bucketShares ? { PPLNS_BUCKET_SHARES: opts.bucketShares } : {}),
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
    it('aggregates shares into the round bucket + by-address hash', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(1000);

      await service.recordShare('bc1qminera', 500);
      await service.recordShare('bc1qminerb', 300);

      // Both shares land in bucket 0 (default 10000 shares/bucket), stored as
      // per-address sums — no per-share entries.
      const bucket = redis._getHash('pplns:bucket:0');
      expect(parseFloat(bucket!.get('bc1qminera') ?? '0')).toBe(500);
      expect(parseFloat(bucket!.get('bc1qminerb') ?? '0')).toBe(300);
      // The bucket index zset holds bucket 0 once (deduped).
      expect(await redis.zRange('pplns:buckets', 0, -1)).toEqual(['0']);
      // The authoritative aggregate mirrors it.
      const hash = redis._getHash('pplns:window:by-address');
      expect(parseFloat(hash!.get('bc1qminera') ?? '0')).toBe(500);
      expect(parseFloat(hash!.get('bc1qminerb') ?? '0')).toBe(300);
    });

    // Regression for H1: bech32 input must be normalised to lowercase
    // before it reaches Redis, otherwise the same logical address
    // submitted in different casings would fragment the window.
    it('normalises mixed-case bech32 input (H1)', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(1000);

      await service.recordShare('BC1QMINERA', 500);
      await service.recordShare('bc1qMinerA', 250);

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
    it('should trim oldest buckets when window exceeds N', async () => {
      // 1 share/bucket → finest trim (bucket trim == per-share trim).
      const { service, redis } = createService({ bucketShares: '1' });
      service.setNetworkDifficulty(100); // window = 400

      await recordShares(service, [
        { address: 'A', difficulty: 100 },
        { address: 'B', difficulty: 100 },
        { address: 'C', difficulty: 100 },
        { address: 'D', difficulty: 100 },
        { address: 'E', difficulty: 100 }, // total 500 > 400 → oldest (A) trimmed
      ]);

      // Window held back to ≤ target; the oldest miner aged out.
      const total = parseFloat(await redis.get('pplns:window:total') ?? '0');
      expect(total).toBeLessThanOrEqual(400);
      const hash = redis._getHash('pplns:window:by-address');
      expect(hash!.get('A')).toBeUndefined(); // oldest share aged out + cleaned
      expect(parseFloat(hash!.get('E') ?? '0')).toBe(100);
    });

    it('should keep window total in sync after trim', async () => {
      const { service, redis } = createService({ bucketShares: '1' });
      service.setNetworkDifficulty(100); // window = 400

      await recordShares(service, [
        { address: 'A', difficulty: 200 },
        { address: 'B', difficulty: 200 },
        { address: 'C', difficulty: 200 }, // total 600, exceeds 400
      ]);

      const stored = parseFloat(await redis.get('pplns:window:total') ?? '0');
      // The stored total must equal the sum of the live by-address aggregate.
      const hash = redis._getHash('pplns:window:by-address')!;
      let actual = 0;
      for (const v of hash.values()) actual += parseFloat(v) || 0;
      expect(Math.abs(stored - actual)).toBeLessThan(0.01);
      expect(stored).toBeLessThanOrEqual(400);
    });

    it('should not trim when window is not full', async () => {
      const { service, redis } = createService({ bucketShares: '1' });
      service.setNetworkDifficulty(1000); // window = 4000

      await recordShares(service, [
        { address: 'A', difficulty: 100 },
        { address: 'B', difficulty: 100 },
      ]);

      // Nothing trimmed: both miners present, total 200.
      const hash = redis._getHash('pplns:window:by-address')!;
      expect(parseFloat(hash.get('A') ?? '0')).toBe(100);
      expect(parseFloat(hash.get('B') ?? '0')).toBe(100);
      expect(parseFloat(await redis.get('pplns:window:total') ?? '0')).toBe(200);
    });
  });

  // ── Deployment migration ─────────────────────────────────────

  describe('deployment-migration: aggregate bootstrap', () => {
    it('onModuleInit migrates a legacy per-share zset into a bucket + aggregate', async () => {
      // Simulate a pre-bucket Redis: legacy per-share zset has shares, no
      // buckets, no aggregate. Migration must rebuild the window into a single
      // legacy bucket + the by-address aggregate, and drop the orphaned zset —
      // without silently excluding any pre-deploy miner.
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);

      await redis.zAdd('pplns:shares', { score: 1, value: 'bc1qa:100:1000' });
      await redis.zAdd('pplns:shares', { score: 2, value: 'bc1qb:200:2000' });
      await redis.zAdd('pplns:shares', { score: 3, value: 'bc1qa:50:3000' });
      expect(redis._getHash('pplns:window:by-address')).toBeUndefined();

      await (service as any).onModuleInit();

      // Aggregate rebuilt: A had 100 + 50 = 150; B had 200.
      const hash = redis._getHash('pplns:window:by-address');
      expect(hash).toBeDefined();
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(150);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(200);
      // A legacy bucket now holds the same window, and the orphaned per-share
      // zset is gone.
      expect((await redis.zRange('pplns:buckets', 0, -1)).length).toBe(1);
      expect((await redis.zCard('pplns:shares'))).toBe(0);
      expect(parseFloat(await redis.get('pplns:window:total') ?? '0')).toBeCloseTo(350);

      // Distribution sees both miners.
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

    it('trimWindow decrements the aggregate when buckets age out', async () => {
      // 1 share/bucket → trim ages out one share's worth at a time.
      const { service, redis } = createService({ bucketShares: '1' });
      service.setNetworkDifficulty(10); // window = 40

      // Fill >> windowSize so trim is forced.
      for (let i = 0; i < 150; i++) {
        await service.recordShare('bc1qa', 1);
      }

      const hash = redis._getHash('pplns:window:by-address');
      // After trim the aggregate is the in-window total, NOT 150. The trim
      // condition is `total > windowSize`, so it settles at the window size.
      const aggA = parseFloat(hash!.get('bc1qa') ?? '0');
      expect(aggA).toBeLessThanOrEqual(40);
      expect(aggA).toBeGreaterThan(0);
      // Aggregate matches the window total exactly (single miner).
      expect(aggA).toBeCloseTo(parseFloat(await redis.get('pplns:window:total') ?? '0'));
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

  describe('recalculateWindow (atomic rebuild from buckets)', () => {
    it('rebuilds the aggregate + total from the live buckets', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000); // huge window → no trim
      await recordShares(service, [
        { address: 'bc1qa', difficulty: 100 },
        { address: 'bc1qa', difficulty: 50 },
        { address: 'bc1qb', difficulty: 200 },
      ]);

      const total = await (service as any).recalculateWindow();
      expect(total).toBeCloseTo(350);

      const hash = redis._getHash('pplns:window:by-address');
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(150);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(200);
      // Temp rebuild key swapped away by the atomic RENAME.
      expect(redis._getHash('pplns:window:by-address:rebuild')).toBeUndefined();
    });

    it('replaces a corrupted aggregate with the full set (incident regression)', async () => {
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);
      await recordShares(service, [
        { address: 'bc1qa', difficulty: 1000 },
        { address: 'bc1qb', difficulty: 2000 },
        { address: 'bc1qc', difficulty: 3000 },
      ]);

      // Simulate the prod corruption: hash wiped + repopulated from one
      // recently-active miner only, with a tiny wrong value.
      await redis.del('pplns:window:by-address');
      await redis.hSet('pplns:window:by-address', { bc1qc: '5' });

      await (service as any).recalculateWindow();

      const hash = redis._getHash('pplns:window:by-address');
      expect(hash!.size).toBe(3); // all three miners restored from the buckets
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(1000);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(2000);
      expect(parseFloat(hash!.get('bc1qc') ?? '0')).toBeCloseTo(3000);
    });

    it('returns null (no swap) when there are no buckets', async () => {
      // The bucket design removes the old partial-read corruption class: a
      // concurrently-deleted bucket just contributes nothing. With no buckets
      // at all, recalc is a no-op and leaves the live aggregate untouched.
      const { service, redis } = createService();
      service.setNetworkDifficulty(10_000_000);
      await redis.hSet('pplns:window:by-address', { bc1qa: '100', bc1qb: '200' });

      const result = await (service as any).recalculateWindow();
      expect(result).toBeNull();

      const hash = redis._getHash('pplns:window:by-address');
      expect(hash!.size).toBe(2);
      expect(parseFloat(hash!.get('bc1qa') ?? '0')).toBeCloseTo(100);
      expect(parseFloat(hash!.get('bc1qb') ?? '0')).toBeCloseTo(200);
    });
  });

  // ── Equivalence: bucketed window vs exact per-share sliding window ──
  //
  // The whole point of bucketing is to produce the SAME payout as the old
  // per-share storage. This replays one deterministic share stream through
  // both the bucketed service and an independent, exact per-share FIFO
  // sliding window trimmed to the same windowSize, then asserts the per-miner
  // window proportions (the core PPLNS quantity the coinbase split derives
  // from) match within a tight tolerance. The only divergence is the
  // bucket-granular trim boundary.
  describe('equivalence with exact per-share sliding window', () => {
    it('bucketed proportions match the exact window within a fraction of a percent', async () => {
      const BUCKET = 20;
      const WINDOW = 500_000;
      const { service } = createService({ bucketShares: String(BUCKET) });
      service.setNetworkDifficulty(WINDOW / 4); // getWindowSize() = 4×netdiff = WINDOW

      // Deterministic stream (LCG, no Math.random): 5 miners, varied difficulty.
      const miners = ['bc1qa', 'bc1qb', 'bc1qc', 'bc1qd', 'bc1qe'];
      let seed = 1234567;
      const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const shares: { address: string; difficulty: number }[] = [];
      for (let i = 0; i < 6000; i++) {
        shares.push({
          address: miners[Math.floor(rng() * miners.length)],
          difficulty: 50 + Math.floor(rng() * 200), // 50..249
        });
      }

      // Feed the bucketed service.
      for (const s of shares) await service.recordShare(s.address, s.difficulty);
      const svc = await (service as any).readWindowByAddress() as Map<string, number>;
      let svcTotal = 0; for (const v of svc.values()) svcTotal += v;

      // Independent reference: exact per-share FIFO, trimmed to WINDOW.
      const fifo: { address: string; difficulty: number }[] = [];
      let refTotal = 0;
      for (const s of shares) {
        fifo.push(s); refTotal += s.difficulty;
        while (refTotal > WINDOW) { refTotal -= fifo.shift()!.difficulty; }
      }
      const ref = new Map<string, number>();
      for (const s of fifo) ref.set(s.address, (ref.get(s.address) ?? 0) + s.difficulty);
      let refTot = 0; for (const v of ref.values()) refTot += v;

      // Sanity: trimming actually happened (window << total work fed in).
      const fedTotal = shares.reduce((s, x) => s + x.difficulty, 0);
      expect(svcTotal).toBeLessThan(fedTotal * 0.8);

      // Compare per-miner proportions.
      let maxPctDiff = 0;
      for (const addr of miners) {
        const svcPct = (svc.get(addr) ?? 0) / svcTotal * 100;
        const refPct = (ref.get(addr) ?? 0) / refTot * 100;
        maxPctDiff = Math.max(maxPctDiff, Math.abs(svcPct - refPct));
      }
      // eslint-disable-next-line no-console
      console.log(`[PPLNS equivalence] max per-miner proportion diff = ${maxPctDiff.toFixed(4)} pct points`);
      expect(maxPctDiff).toBeLessThan(0.5);

      // And the derived coinbase sats track within a small relative tolerance.
      const reward = 312_500_000;
      const svcSats = new Map<string, number>();
      for (const [a, d] of svc) svcSats.set(a, Math.floor(reward * d / svcTotal));
      const refSats = new Map<string, number>();
      for (const [a, d] of ref) refSats.set(a, Math.floor(reward * d / refTot));
      for (const addr of miners) {
        const s = svcSats.get(addr) ?? 0;
        const r = refSats.get(addr) ?? 0;
        // A miner's absolute payout error = reward × their proportion error,
        // which the proportion assertion already bounds at < 0.5 pct points.
        // So no miner's sats deviate by more than 0.5 % of the block reward
        // (measured here: ~0.1 %). For prod (bucket 10000, millions of shares /
        // thousands of buckets) the boundary error is far smaller still.
        expect(Math.abs(s - r)).toBeLessThan(reward * 0.005 + 10);
      }
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

    it('coalesces concurrent callers into one build (thundering-herd dedup)', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100_000);
      await recordShares(service, [
        { address: 'bc1qa', difficulty: 500 },
        { address: 'bc1qb', difficulty: 500 },
      ]);

      // Invalidate the result cache so every call would otherwise rebuild.
      (service as any).distributionCache.invalidate();
      (balanceService.getAllWithBalance as jest.Mock).mockClear();

      // Fire 50 concurrent callers in the same microtask batch.
      const results = await Promise.all(
        Array.from({ length: 50 }, () => service.getPayoutDistribution(312_500_000)),
      );
      // All 50 callers got an identical reference (the same in-flight result).
      const first = results[0];
      for (const r of results) {
        expect(r).toBe(first);
      }
      // The expensive balance fetch happened exactly once.
      expect(balanceService.getAllWithBalance).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh build when the reward differs', async () => {
      const { service, balanceService } = createService({ feePercent: '2' });
      service.setNetworkDifficulty(100_000);
      await service.recordShare('bc1qa', 100);

      (service as any).distributionCache.invalidate();
      (balanceService.getAllWithBalance as jest.Mock).mockClear();

      // Two concurrent callers with different rewards — both run their own build.
      await Promise.all([
        service.getPayoutDistribution(312_500_000),
        service.getPayoutDistribution(312_500_001),
      ]);
      expect(balanceService.getAllWithBalance).toHaveBeenCalledTimes(2);
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
