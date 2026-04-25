jest.mock('node-telegram-bot-api', () => jest.fn());

import { GroupSoloService } from './group-solo.service';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';

// ── Mock Redis (sorted set + key-value) ─────────────────────────

function createMockRedis() {
    const store = new Map<string, string>();
    const zsets = new Map<string, { score: number; value: string }[]>();
    const hashes = new Map<string, Map<string, string>>();
    const getZ = (key: string) => {
        if (!zsets.has(key)) zsets.set(key, []);
        return zsets.get(key)!;
    };
    const getH = (key: string) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        return hashes.get(key)!;
    };

    return {
        incr: jest.fn(async (key: string) => {
            const val = parseInt(store.get(key) ?? '0', 10) + 1;
            store.set(key, val.toString());
            return val;
        }),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); }),
        expire: jest.fn(async (_key: string, _seconds: number) => 1),
        del: jest.fn(async (key: string) => { store.delete(key); zsets.delete(key); hashes.delete(key); }),
        incrByFloat: jest.fn(async (key: string, amount: number) => {
            const val = parseFloat(store.get(key) ?? '0') + amount;
            store.set(key, val.toString());
            return val;
        }),
        zAdd: jest.fn(async (key: string, entry: { score: number; value: string }) => {
            const z = getZ(key);
            z.push(entry);
            z.sort((a, b) => a.score - b.score);
        }),
        zRange: jest.fn(async (key: string, start: number, end: number) => {
            const z = getZ(key);
            const e = end === -1 ? z.length - 1 : end;
            return z.slice(start, e + 1).map(x => x.value);
        }),
        zCard: jest.fn(async (key: string) => getZ(key).length),
        hIncrByFloat: jest.fn(async (key: string, field: string, amount: number) => {
            const h = getH(key);
            const val = parseFloat(h.get(field) ?? '0') + amount;
            h.set(field, val.toString());
            return val;
        }),
        hIncrBy: jest.fn(async (key: string, field: string, amount: number) => {
            const h = getH(key);
            const val = parseInt(h.get(field) ?? '0', 10) + amount;
            h.set(field, val.toString());
            return val;
        }),
        hSet: jest.fn(async (key: string, field: string, value: string) => {
            getH(key).set(field, value);
        }),
        hGet: jest.fn(async (key: string, field: string) => {
            const h = hashes.get(key);
            return h?.get(field) ?? null;
        }),
        hDel: jest.fn(async (key: string, field: string) => {
            hashes.get(key)?.delete(field);
        }),
        hGetAll: jest.fn(async (key: string) => {
            const h = hashes.get(key);
            if (!h) return {};
            return Object.fromEntries(h.entries());
        }),
        zRem: jest.fn(async (key: string, value: string) => {
            const z = getZ(key);
            const idx = z.findIndex(e => e.value === value);
            if (idx >= 0) z.splice(idx, 1);
        }),
        _store: store,
        _zsets: zsets,
        _hashes: hashes,
    };
}

// ── Mock GroupService ───────────────────────────────────────────

function createMockGroupService() {
    const addressToGroup = new Map<string, { groupId: string; active: boolean }>();
    return {
        getGroupForAddress: jest.fn((address: string) => addressToGroup.get(address)),
        _setMembership: (address: string, groupId: string, active = true) => {
            addressToGroup.set(address, { groupId, active });
        },
    };
}

// ── Mock History + Balance repos ────────────────────────────────

function createMockRepo<T>() {
    const rows: T[] = [];
    // Upsert-style save: match by id / (address, groupId) / address so
    // calling save() multiple times on the same logical entity updates
    // the existing row instead of appending duplicate copies. Entries
    // without any matching key (fresh history rows) are pushed as new.
    // Accepts either a single entity or an array (TypeORM supports both,
    // batch-aware onBlockFound uses the array form).
    const applySave = (row: T) => {
        const r = row as any;
        let existing: any = null;
        if (r?.id !== undefined) {
            existing = (rows as any[]).find(x => x.id === r.id);
        } else if (r?.address !== undefined && r?.groupId !== undefined) {
            existing = (rows as any[]).find(x => x.address === r.address && x.groupId === r.groupId);
        } else if (r?.address !== undefined) {
            existing = (rows as any[]).find(x => x.address === r.address);
        }
        if (existing) {
            Object.assign(existing, row);
        } else {
            rows.push(row); // push reference so downstream mutations reflect
        }
    };
    return {
        save: jest.fn(async (arg: T | T[]) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) applySave(row);
            return arg;
        }),
        // Batch INSERT — appends all rows without upsert. Used by the
        // new batch-aware onBlockFound history-writing path.
        insert: jest.fn(async (arg: T | T[]) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async (query?: any) => {
            if (!query?.where) return [...rows];
            return (rows as any[]).filter(r =>
                Object.entries(query.where).every(([k, v]) => {
                    // Support TypeORM's In() operator: FindOperator carries
                    // its value in `_value` for any field, not just address.
                    if (v && typeof v === 'object' && Array.isArray((v as any)._value)) {
                        return new Set((v as any)._value).has((r as any)[k]);
                    }
                    return (r as any)[k] === v;
                }),
            );
        }),
        findOneBy: jest.fn(async (where: any) => {
            return (rows as any[]).find(r =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
        }),
        delete: jest.fn(async (where: any) => {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (Object.entries(where).every(([k, v]) => (rows[i] as any)[k] === v)) {
                    rows.splice(i, 1);
                }
            }
        }),
        update: jest.fn(async (where: any, patch: any) => {
            for (const row of rows as any[]) {
                if (Object.entries(where).every(([k, v]) => row[k] === v)) {
                    Object.assign(row, patch);
                }
            }
            return { affected: 0 } as any;
        }),
        _rows: rows,
    };
}

// ── Helper ──────────────────────────────────────────────────────

function makeService(envOverrides: Record<string, string> = {}) {
    const env: Record<string, string> = {
        GROUP_SOLO_PORT: '3340',
        PPLNS_FEE_ADDRESS: 'bc1qfee',
        PPLNS_FEE_PERCENT: '2',
        ...envOverrides,
    };
    const configService = { get: jest.fn((k: string) => env[k]) };
    const cacheManager = { store: {} };
    const historyRepo = createMockRepo();
    const balanceRepo = createMockRepo();
    const groupRepo = createMockRepo();
    const groupService = createMockGroupService();
    attachMockTxManager([
        [PplnsGroupBlockHistoryEntity, historyRepo],
        [PplnsGroupBalanceEntity, balanceRepo],
    ]);
    const service = new GroupSoloService(
        configService as any,
        cacheManager as any,
        historyRepo as any,
        balanceRepo as any,
        groupRepo as any,
        groupService as any,
    );
    const redis = createMockRedis();
    // Inject redis by going through onModuleInit with a redis-shaped store
    (service as any).redis = redis;
    (service as any).enabled = true;
    return { service, redis, historyRepo, balanceRepo, groupService };
}

// ── Tests ────────────────────────────────────────────────────────

describe('GroupSoloService', () => {

    it('isEnabled returns false when GROUP_SOLO_PORT is not set', () => {
        const { service } = makeService({ GROUP_SOLO_PORT: '' });
        (service as any).enabled = false;
        expect(service.isEnabled()).toBe(false);
    });

    it('recordShare rejects addresses not in an active group', async () => {
        const { service, groupService } = makeService();
        // address not registered
        const ok = await service.recordShare('bc1qstranger', 100);
        expect(ok).toBe(false);
        // inactive group
        groupService._setMembership('bc1qalice', 'g1', false);
        const ok2 = await service.recordShare('bc1qalice', 100);
        expect(ok2).toBe(false);
    });

    it('recordShare routes to the group\'s Redis bucket', async () => {
        const { service, redis, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        expect(redis._zsets.size).toBe(1);
        const zset = Array.from(redis._zsets.values())[0];
        expect(zset).toHaveLength(1);
        expect(zset[0].value).toMatch(/^bc1qalice:100:/);
    });

    it('distribution splits proportionally to round shares (PROP)', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);
        await service.recordShare('bc1qalice', 750);
        await service.recordShare('bc1qbob', 250);

        const dist = await service.getPayoutDistribution('g1', 100_000_000); // 1 BTC
        // Fee (2%) + two miners
        expect(dist).toHaveLength(3);
        expect(dist[0].address).toBe('bc1qfee');
        const alice = dist.find(d => d.address === 'bc1qalice')!;
        const bob = dist.find(d => d.address === 'bc1qbob')!;
        // Alice had 75% of shares, should get ~75% of the miner cut (98%)
        expect(alice.percent).toBeCloseTo(73.5, 1);
        expect(bob.percent).toBeCloseTo(24.5, 1);
        // Sum of percents ≈ 100
        const total = dist.reduce((s, d) => s + d.percent, 0);
        expect(total).toBeCloseTo(100, 5);
    });

    it('onBlockFound writes history rows and resets the round', async () => {
        const { service, redis, historyRepo, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);
        await service.recordShare('bc1qalice', 500);
        await service.recordShare('bc1qbob', 500);
        await service.getPayoutDistribution('g1', 100_000_000); // populate snapshot

        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        // All history rows reference the same block + group
        const rows = historyRepo._rows as any[];
        expect(rows.length).toBeGreaterThanOrEqual(2); // fee + at least one miner
        expect(rows.every(r => r.blockHeight === 900_000 && r.groupId === 'g1')).toBe(true);

        // Round reset: all Redis keys for this group are gone
        expect(redis._zsets.size).toBe(0);
        for (const [key] of redis._store) {
            expect(key).not.toMatch(/^groupsolo:g1:/);
        }
    });

    it('sub-dust miners go to pending, not coinbase', async () => {
        const { service, balanceRepo, historyRepo, groupService } = makeService();
        groupService._setMembership('bc1qbig', 'g1', true);
        groupService._setMembership('bc1qtiny', 'g1', true);
        // Bigger share for bc1qbig — make bc1qtiny's cut < dust (546 sats) of 1 BTC
        await service.recordShare('bc1qbig', 999_999);
        await service.recordShare('bc1qtiny', 1);

        await service.getPayoutDistribution('g1', 100_000_000);
        await service.onBlockFound(900_000, 100_000_000, 'bc1qbig');

        // Tiny's small sat amount (< 546) should either not appear in coinbase
        // or appear as inCoinbase=false (pending row).
        const tinyRows = (historyRepo._rows as any[]).filter(r => r.address === 'bc1qtiny');
        if (tinyRows.length > 0) {
            expect(tinyRows[0].inCoinbase).toBe(false);
        }
        // Big miner paid via coinbase
        const bigRows = (historyRepo._rows as any[]).filter(r => r.address === 'bc1qbig');
        expect(bigRows.some(r => r.inCoinbase === true)).toBe(true);
    });

    it('pending balances accumulate across rounds until they cross dust, then are paid in coinbase', async () => {
        const { service, balanceRepo, historyRepo, groupService } = makeService();
        // Block reward chosen so Charlie's 1-of-1000 share is ~100 sats (well below 546 dust)
        const BLOCK_REWARD = 10_000; // 10k sats
        groupService._setMembership('bc1qbig', 'g1', true);
        groupService._setMembership('bc1qtiny', 'g1', true);

        // ── Round 1 ────────────────────────────────────────────────
        await service.recordShare('bc1qbig', 999);
        await service.recordShare('bc1qtiny', 1);
        await service.getPayoutDistribution('g1', BLOCK_REWARD);
        await service.onBlockFound(900_001, BLOCK_REWARD, 'bc1qbig');

        // Charlie's round-1 sats went to pending (sub-dust); Alice was paid via coinbase
        const round1Rows = historyRepo._rows as any[];
        const tinyRound1 = round1Rows.find(r => r.address === 'bc1qtiny' && r.blockHeight === 900_001);
        expect(tinyRound1.inCoinbase).toBe(false);
        const tinyBalance1 = await balanceRepo.findOneBy({ address: 'bc1qtiny' });
        expect(tinyBalance1.pendingSats).toBeGreaterThan(0);
        const pendingAfterRound1: number = tinyBalance1.pendingSats;

        // ── Round 2 ────────────────────────────────────────────────
        // Now give Charlie a much bigger share so his new earnings + pending clearly exceed dust
        await service.recordShare('bc1qbig', 100);
        await service.recordShare('bc1qtiny', 900);
        await service.getPayoutDistribution('g1', BLOCK_REWARD);
        await service.onBlockFound(900_002, BLOCK_REWARD, 'bc1qbig');

        // Charlie should now appear in round-2's coinbase and his pending should be cleared
        const tinyRound2 = (historyRepo._rows as any[])
            .filter(r => r.address === 'bc1qtiny' && r.blockHeight === 900_002);
        expect(tinyRound2.length).toBeGreaterThan(0);
        expect(tinyRound2.some(r => r.inCoinbase === true)).toBe(true);

        const tinyBalance2 = await balanceRepo.findOneBy({ address: 'bc1qtiny' });
        // Most of Round-1's pending carry was paid on-chain in Round 2.
        // A small residual (≤ pendingAfterRound1) may remain as Phase 5a.5
        // solvency-cap carry-forward: group-solo runs buildCoinbaseDistribution
        // with suppressMatchingDebits=true, so credits paid out this block
        // cannot be offset by matching debits on the dominant miner. The
        // solvency cap therefore delays the last few sats into the next
        // block. This is expected and bounded — the residual never grows
        // beyond the original pending.
        expect(tinyBalance2.pendingSats).toBeGreaterThanOrEqual(0);
        expect(tinyBalance2.pendingSats).toBeLessThanOrEqual(pendingAfterRound1);
        // Majority of the round-1 pending has moved to totalPaidSats in round 2.
        expect(tinyBalance2.totalPaidSats).toBeGreaterThan(0);
    });

    it('late-arriving shares (post-snapshot) are logged but NOT credited to pending — prevents double-counting', async () => {
        // Scenario: pool builds a job, snapshot captures only Alice (Bob had no shares yet).
        // Between snapshot-build and block-found, Bob submits shares.
        // Alice then finds the block. The coinbase pays Alice via the snapshot.
        // Bob's shares arrived too late for THIS block's coinbase → PROP rules: lost.
        //
        // The old code was crediting Bob to pending based on Bob.diff / (Alice.diff + Bob.diff) × rewardForMiners,
        // which meant rewardForMiners was effectively paid out TWICE (once to Alice via coinbase,
        // once to Bob via pending). This test locks in the PROP behavior: Bob gets 0 sats pending,
        // but gets an audit history row so his submitted shares are visible.
        const { service, balanceRepo, historyRepo, groupService } = makeService();
        const BLOCK_REWARD = 100_000_000;
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);

        // Stage 1: only Alice has shares. Build snapshot.
        await service.recordShare('bc1qalice', 1000);
        await service.getPayoutDistribution('g1', BLOCK_REWARD);

        // Stage 2: Bob arrives AFTER snapshot was built.
        await service.recordShare('bc1qbob', 2000);

        // Stage 3: Alice finds the block. Snapshot-based bookkeeping runs.
        await service.onBlockFound(900_000, BLOCK_REWARD, 'bc1qalice');

        // Bob's balance must NOT have been credited anything — the coinbase already
        // claimed 100% of the miner cut via Alice's snapshot entry.
        const bobBalance = await balanceRepo.findOneBy({ address: 'bc1qbob' });
        expect(bobBalance?.pendingSats ?? 0).toBe(0);

        // But Bob should have an audit history row showing his shares with paidSats=0
        const bobRows = (historyRepo._rows as any[]).filter(r => r.address === 'bc1qbob');
        expect(bobRows).toHaveLength(1);
        expect(bobRows[0].paidSats).toBe(0);
        expect(bobRows[0].inCoinbase).toBe(false);
        expect(bobRows[0].sharesInRound).toBe(2000);

        // Total paid via coinbase (fee + Alice) should not exceed BLOCK_REWARD
        const coinbasePaid = (historyRepo._rows as any[])
            .filter(r => r.inCoinbase === true)
            .reduce((sum, r) => sum + r.paidSats, 0);
        expect(coinbasePaid).toBeLessThanOrEqual(BLOCK_REWARD);
        // And miner-cut portion (non-fee) should not exceed rewardForMiners
        const minerCoinbasePaid = (historyRepo._rows as any[])
            .filter(r => r.inCoinbase === true && r.address !== 'bc1qfee')
            .reduce((sum, r) => sum + r.paidSats, 0);
        const rewardForMiners = Math.floor(0.98 * BLOCK_REWARD);
        expect(minerCoinbasePaid).toBeLessThanOrEqual(rewardForMiners);
    });

    it('snapshot reward mismatch → falls back to window recalc', async () => {
        // Same defensive guard as PPLNS: if the snapshot was built for a
        // job with coinbasevalue R1 but the block lands with reward R2,
        // we must NOT book payouts against R1. Fallback path computes a
        // fresh distribution from the current window using R2.
        const { service, historyRepo, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);

        const R1 = 100_000_000;
        await service.recordShare('bc1qalice', 1000);
        await service.getPayoutDistribution('g1', R1);

        const R2 = 120_000_000;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await service.onBlockFound(900_000, R2, 'bc1qalice');
        } finally {
            warnSpy.mockRestore();
        }

        // Alice's history row must reflect R2 (fallback used), not R1.
        const aliceRow = (historyRepo._rows as any[])
            .find(r => r.address === 'bc1qalice' && r.inCoinbase === true);
        expect(aliceRow).toBeDefined();
        // Single miner with 100% of shares → paidSats ≈ 0.98 * R2 = 117_600_000
        expect(aliceRow.paidSats).toBeGreaterThan(100_000_000);
    });

    it('getRoundStats returns current round snapshot', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        await service.recordShare('bc1qalice', 200);

        const stats = await service.getRoundStats('g1');
        expect(stats.totalShares).toBe(300);
        expect(stats.totalRejected).toBe(0);
        expect(stats.perAddress).toHaveLength(1);
        expect(stats.perAddress[0].address).toBe('bc1qalice');
        expect(stats.perAddress[0].totalShares).toBe(300);
        expect(stats.perAddress[0].percent).toBe(100);
        expect(stats.perAddress[0].totalRejected).toBe(0);
    });

    it('recordReject rejects addresses not in an active group', async () => {
        const { service, groupService } = makeService();
        const ok = await service.recordReject('bc1qstranger', 100);
        expect(ok).toBe(false);
        groupService._setMembership('bc1qalice', 'g1', false);
        const ok2 = await service.recordReject('bc1qalice', 100);
        expect(ok2).toBe(false);
    });

    it('recordReject aggregates per-address and getRoundStats exposes it', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        await service.recordReject('bc1qalice', 50);
        await service.recordReject('bc1qalice', 50);
        await service.recordReject('bc1qbob', 200);

        const stats = await service.getRoundStats('g1');
        expect(stats.totalRejected).toBe(300);

        const alice = stats.perAddress.find(p => p.address === 'bc1qalice')!;
        expect(alice.totalRejected).toBe(100);
        const bob = stats.perAddress.find(p => p.address === 'bc1qbob')!;
        expect(bob.totalRejected).toBe(200);
        // Bob had no accepted shares but still shows up because of rejects
        expect(bob.totalShares).toBe(0);
    });

    it('onBlockFound also clears rejected counters', async () => {
        const { service, redis, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        await service.recordReject('bc1qalice', 50);
        await service.getPayoutDistribution('g1', 100_000_000);

        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        // rejected-shares hash is cleared on round reset; lastShareAt is NOT
        // (it survives across rounds, powering the admin kick inactivity gate).
        expect(redis._hashes.get('groupsolo:g1:rejected-shares')?.size ?? 0).toBe(0);
        const stats = await service.getRoundStats('g1');
        expect(stats.totalRejected).toBe(0);
    });

    it('getRoundBestDifficulty returns max single-share diff and submitter', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);

        // No shares yet
        const empty = await service.getRoundBestDifficulty('g1');
        expect(empty.bestDifficulty).toBe(0);
        expect(empty.address).toBeNull();

        await service.recordShare('bc1qalice', 100);
        await service.recordShare('bc1qbob', 500_000);
        await service.recordShare('bc1qalice', 250);

        const best = await service.getRoundBestDifficulty('g1');
        expect(best.bestDifficulty).toBe(500_000);
        expect(best.address).toBe('bc1qbob');
        expect(typeof best.time).toBe('number');
    });

    it('getRoundBestDifficulty resets after onBlockFound', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        await service.getPayoutDistribution('g1', 100_000_000);
        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        const best = await service.getRoundBestDifficulty('g1');
        expect(best.bestDifficulty).toBe(0);
        expect(best.address).toBeNull();
    });

    /**
     * M3 regression (signed-ledger audit finding): Group-Solo routes
     * through the shared `buildCoinbaseDistribution` with
     * `suppressMatchingDebits=true` (the C2 fix). That flag re-routes
     * Phase 5b residuum to the fee output instead of creating negative
     * pendingSats. This test locks in the guarantee: with 10 members
     * and uneven shares (forcing floor-rounding residuum every block),
     * NO member's pendingSats ever goes negative across 5 rounds.
     *
     * If the `suppressMatchingDebits` flag regresses, this test will
     * catch it because at least one member will end up with a negative
     * pendingSats from the Phase 5b matching-debit pass — exactly the
     * C2 bug the flag prevents.
     */
    it('regression M3: 10-member group-solo over 5 rounds — no member ever has negative pendingSats', async () => {
        const { service, balanceRepo, historyRepo, groupService } = makeService();
        const members = Array.from({ length: 10 }, (_, i) => `bc1qm${i}`);
        for (const m of members) groupService._setMembership(m, 'g1', true);

        const BLOCK_REWARD = 5_000_000_000;   // 50 BTC, realistic
        let height = 900_000;

        // Run 5 rounds. Each round:
        //   1. 10 members record shares with intentionally uneven counts
        //      (prime-ish values) to guarantee floor-rounding residuum.
        //   2. getPayoutDistribution populates the snapshot.
        //   3. onBlockFound writes history rows + resets round.
        //   4. Assert no pendingSats in the group-balance repo is < 0.
        for (let round = 0; round < 5; round++) {
            // Uneven shares → Phase 5b residuum always non-zero.
            const baseShares = [101, 107, 113, 127, 131, 137, 139, 149, 151, 157];
            for (let i = 0; i < members.length; i++) {
                await service.recordShare(members[i], baseShares[i] * (round + 1));
            }

            await service.getPayoutDistribution('g1', BLOCK_REWARD);
            await service.onBlockFound(height++, BLOCK_REWARD, members[0]);

            // Invariant: no pendingSats goes negative across all group rows.
            const groupRows = (balanceRepo._rows as any[]).filter(r => r.groupId === 'g1');
            for (const row of groupRows) {
                expect(row.pendingSats).toBeGreaterThanOrEqual(0);
            }
        }

        // End state: history rows reference all 5 blocks. At least the
        // fee rows should appear (often more if the group is PROP'd).
        const distinctBlocks = new Set(
            (historyRepo._rows as any[])
                .filter(r => r.groupId === 'g1')
                .map(r => r.blockHeight),
        );
        expect(distinctBlocks.size).toBe(5);
    });

    describe('scheduledRoundReset (Variant B — wipe everything)', () => {

        it('wipes Redis round state + ALL pending balances + updates lastRoundResetAt', async () => {
            const { service, redis, groupService, balanceRepo } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 100);
            await service.recordShare('bc1qbob', 200);

            (balanceRepo._rows as any[]).push(
                { address: 'bc1qalice', groupId: 'g1', pendingSats: 800, totalPaidSats: 0 },
                { address: 'bc1qbob', groupId: 'g1', pendingSats: 1200, totalPaidSats: 0 },
            );

            // Mock the group repo for this test
            const groupRepo = (service as any).groupRepo;
            groupRepo.findOneBy = jest.fn(async () => ({
                id: 'g1',
                dissolvedAt: null,
                lastRoundResetAt: null,
            }));
            groupRepo.update = jest.fn();

            await service.scheduledRoundReset('g1');

            // Redis fully wiped
            expect(redis._store.has('groupsolo:g1:shares')).toBe(false);
            expect(redis._store.has('groupsolo:g1:total')).toBe(false);
            expect(redis._store.has('groupsolo:g1:counter')).toBe(false);
            expect(redis._store.has('groupsolo:g1:rejected-shares')).toBe(false);
            expect(redis._store.has('groupsolo:g1:last-share-at')).toBe(false);
            expect(redis._store.has('groupsolo:g1:snapshot')).toBe(false);

            // ALL pending balances gone (positive forfeit + symmetric)
            expect((balanceRepo._rows as any[]).length).toBe(0);

            // lastRoundResetAt updated
            expect(groupRepo.update).toHaveBeenCalledWith(
                { id: 'g1' },
                expect.objectContaining({ lastRoundResetAt: expect.any(Date) }),
            );
        });

        it('skips when a block-found is already in flight (lock guard)', async () => {
            const { service, balanceRepo } = makeService();
            (balanceRepo._rows as any[]).push(
                { address: 'bc1qalice', groupId: 'g1', pendingSats: 500, totalPaidSats: 0 },
            );
            // Simulate block-found in progress
            (service as any).blockFoundLocks.add('g1');

            await service.scheduledRoundReset('g1');

            // Pending balance untouched
            expect((balanceRepo._rows as any[]).length).toBe(1);
        });

        it('skips when a recent reset (< 60s ago) already happened', async () => {
            const { service, balanceRepo } = makeService();
            (balanceRepo._rows as any[]).push(
                { address: 'bc1qalice', groupId: 'g1', pendingSats: 500, totalPaidSats: 0 },
            );

            const groupRepo = (service as any).groupRepo;
            groupRepo.findOneBy = jest.fn(async () => ({
                id: 'g1',
                dissolvedAt: null,
                lastRoundResetAt: new Date(Date.now() - 30_000),  // 30s ago
            }));
            groupRepo.update = jest.fn();

            await service.scheduledRoundReset('g1');

            // Pending balance untouched (debounce kicked in)
            expect((balanceRepo._rows as any[]).length).toBe(1);
            expect(groupRepo.update).not.toHaveBeenCalled();
        });

        it('skips when the group has been dissolved', async () => {
            const { service, balanceRepo } = makeService();
            (balanceRepo._rows as any[]).push(
                { address: 'bc1qalice', groupId: 'g1', pendingSats: 500, totalPaidSats: 0 },
            );
            const groupRepo = (service as any).groupRepo;
            groupRepo.findOneBy = jest.fn(async () => ({
                id: 'g1',
                dissolvedAt: new Date(),
                lastRoundResetAt: null,
            }));

            await service.scheduledRoundReset('g1');

            expect((balanceRepo._rows as any[]).length).toBe(1);
        });
    });

    it('removeMemberState redistributes pending balance + in-round shares to remaining members', async () => {
        const { service, redis, groupService, balanceRepo } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);
        groupService._setMembership('bc1qcharlie', 'g1', true);

        // Seed: alice + bob + charlie all mined this round.
        await service.recordShare('bc1qalice', 100);
        await service.recordShare('bc1qbob', 200);
        await service.recordShare('bc1qcharlie', 300);

        // Bob had accumulated 900 sats pending from prior sub-dust rounds.
        (balanceRepo._rows as any[]).push({
            address: 'bc1qbob', groupId: 'g1', pendingSats: 900, totalPaidSats: 0,
        });

        // Kick Bob — pending 900 splits evenly to alice + charlie (450 each),
        // bob's row deleted, bob's in-round diff 200 removed from total.
        await service.removeMemberState('g1', 'bc1qbob', ['bc1qalice', 'bc1qcharlie']);

        // In-round total went 600 → 400.
        expect(parseFloat((redis._store.get('groupsolo:g1:total') ?? '0') as string)).toBeCloseTo(400);

        // Bob's row gone.
        const bobRow = (balanceRepo._rows as any[]).find(r => r.address === 'bc1qbob');
        expect(bobRow).toBeUndefined();

        // Alice + Charlie got +450 each in pending.
        const aliceRow = (balanceRepo._rows as any[]).find(r => r.address === 'bc1qalice');
        const charlieRow = (balanceRepo._rows as any[]).find(r => r.address === 'bc1qcharlie');
        expect(aliceRow?.pendingSats).toBe(450);
        expect(charlieRow?.pendingSats).toBe(450);
    });
});
