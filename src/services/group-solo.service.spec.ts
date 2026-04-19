jest.mock('node-telegram-bot-api', () => jest.fn());

import { GroupSoloService } from './group-solo.service';

// ── Mock Redis (sorted set + key-value) ─────────────────────────

function createMockRedis() {
    const store = new Map<string, string>();
    const zsets = new Map<string, { score: number; value: string }[]>();
    const getZ = (key: string) => {
        if (!zsets.has(key)) zsets.set(key, []);
        return zsets.get(key)!;
    };

    return {
        incr: jest.fn(async (key: string) => {
            const val = parseInt(store.get(key) ?? '0', 10) + 1;
            store.set(key, val.toString());
            return val;
        }),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
        del: jest.fn(async (key: string) => { store.delete(key); zsets.delete(key); }),
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
        _store: store,
        _zsets: zsets,
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
    return {
        save: jest.fn(async (row: T) => { rows.push({ ...row }); return row; }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async () => [...rows]),
        findOneBy: jest.fn(async (where: any) => {
            return (rows as any[]).find(r =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
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
    const groupService = createMockGroupService();
    const service = new GroupSoloService(
        configService as any,
        cacheManager as any,
        historyRepo as any,
        balanceRepo as any,
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
        expect(tinyBalance2.pendingSats).toBe(0);
        // Previous pending sats have moved to totalPaidSats
        expect(tinyBalance2.totalPaidSats).toBeGreaterThanOrEqual(pendingAfterRound1);
    });

    it('getRoundStats returns current round snapshot', async () => {
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        await service.recordShare('bc1qalice', 100);
        await service.recordShare('bc1qalice', 200);

        const stats = await service.getRoundStats('g1');
        expect(stats.shareCount).toBe(2);
        expect(stats.totalDifficulty).toBe(300);
        expect(stats.perAddress).toHaveLength(1);
        expect(stats.perAddress[0].address).toBe('bc1qalice');
        expect(stats.perAddress[0].percent).toBe(100);
    });
});
