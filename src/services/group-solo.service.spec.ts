jest.mock('node-telegram-bot-api', () => jest.fn());

import { GroupSoloService } from './group-solo.service';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import { readStoredSnapshot } from './coinbase-snapshot';

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
        del: jest.fn(async (keyOrKeys: string | string[]) => {
            const ks = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            for (const k of ks) { store.delete(k); zsets.delete(k); hashes.delete(k); }
        }),
        unlink: jest.fn(async (keyOrKeys: string | string[]) => {
            const ks = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            for (const k of ks) { store.delete(k); zsets.delete(k); hashes.delete(k); }
        }),
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
        hSet: jest.fn(async (key: string, fieldOrObj: string | Record<string, string>, value?: string) => {
            const h = getH(key);
            if (typeof fieldOrObj === 'string') {
                h.set(fieldOrObj, value as string);
            } else {
                for (const [f, v] of Object.entries(fieldOrObj)) {
                    h.set(f, v);
                }
            }
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
        zRem: jest.fn(async (key: string, value: string | string[]) => {
            const z = getZ(key);
            const targets = Array.isArray(value) ? value : [value];
            const targetSet = new Set(targets);
            for (let i = z.length - 1; i >= 0; i--) {
                if (targetSet.has(z[i].value)) z.splice(i, 1);
            }
        }),
        // Minimal node-redis v4 multi() shim. The real client batches the
        // chained commands and sends them in one round-trip; for tests we
        // just record calls and replay them sequentially against the same
        // mock store on exec(). This is the path production uses for
        // recordShare (4 chained writes) and the byAddress backfill.
        multi: jest.fn(function multi(this: any) {
            const ops: Array<() => Promise<unknown>> = [];
            const self = this;
            const chain = {
                zAdd(key: string, entry: { score: number; value: string }) {
                    ops.push(() => self.zAdd(key, entry));
                    return chain;
                },
                incrByFloat(key: string, amount: number) {
                    ops.push(() => self.incrByFloat(key, amount));
                    return chain;
                },
                hSet(key: string, field: string, value: string) {
                    ops.push(() => self.hSet(key, field, value));
                    return chain;
                },
                hIncrByFloat(key: string, field: string, amount: number) {
                    ops.push(() => self.hIncrByFloat(key, field, amount));
                    return chain;
                },
                hDel(key: string, field: string) {
                    ops.push(() => self.hDel(key, field));
                    return chain;
                },
                del(key: string | string[]) {
                    ops.push(() => self.del(key));
                    return chain;
                },
                async exec() {
                    const results: unknown[] = [];
                    for (const op of ops) results.push(await op());
                    return results;
                },
            };
            return chain;
        }),
        // node-redis v4 cursor-based SCAN. The mock returns ALL matching
        // keys in a single page since the in-memory store is small;
        // production code must still use a do/while loop because it
        // can't assume that.
        scan: jest.fn(async (_cursor: number, opts: { MATCH: string; COUNT?: number }) => {
            // Translate Redis-glob (`*`) into a regex anchor. We only
            // need the `*` wildcard for snapshot prefix scans — full
            // glob support isn't required for tests.
            const pattern = opts.MATCH;
            const regex = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
            const allKeys = [
                ...store.keys(),
                ...zsets.keys(),
                ...hashes.keys(),
            ];
            const matched = allKeys.filter(k => regex.test(k));
            return { cursor: 0, keys: Array.from(new Set(matched)) };
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
    return { service, redis, historyRepo, balanceRepo, groupRepo, groupService };
}

/**
 * Opt a group into per-block round reset (resetRoundOnBlock=true). The default
 * is now false (accumulate across blocks), so tests that assert the round is
 * WIPED on block-found must enable the legacy reset behaviour explicitly.
 */
function enablePerBlockReset(service: GroupSoloService, groupId = 'g1'): void {
    const repo = (service as any).groupRepo;
    const existing = (repo._rows as any[]).find((r) => r.id === groupId);
    if (existing) existing.resetRoundOnBlock = true;
    else (repo._rows as any[]).push({ id: groupId, resetRoundOnBlock: true });
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
        // Round state is a per-address aggregate hash (no per-share zSet).
        const byAddr = redis._hashes.get('groupsolo:g1:by-address');
        expect(byAddr).toBeDefined();
        expect(parseFloat(byAddr!.get('bc1qalice')!)).toBe(100);
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

    it('empty-window fallback emits a fee output with the actual block reward (regression: not 0 sats)', async () => {
        // Pre-fix bug: getPayoutDistribution called this.fallback() (no
        // arg) on the !isEnabled / empty-window paths, returning
        // [{ feeAddress, percent: 100, sats: 0 }]. Callers checked only
        // `length > 0`, so a 0-sat fee output would silently pass through
        // into the coinbase. Now: fallback requires blockRewardSats and
        // emits the real value.
        const REWARD = 100_000_000;
        const { service, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        // Explicitly do NOT record any shares — exercises the empty-zRange
        // early-exit path inside getPayoutDistribution.

        const dist = await service.getPayoutDistribution('g1', REWARD);

        expect(dist).toHaveLength(1);
        expect(dist[0]).toEqual({
            address: 'bc1qfee',
            percent: 100,
            sats: REWARD,
        });
    });

    /**
     * Dispatch-window distribution cache: under the new-job fan-out, 400
     * stratum sessions all call `getPayoutDistribution` with the same
     * (groupId, blockRewardSats, finderAddress) triple. Pre-cache, this
     * cost 400× the inner compute + 800 PG round-trips (balanceRepo +
     * groupRepo). After: 1× compute, 399× hash lookup. Mirrors the
     * existing PplnsService cache pattern (DISTRIBUTION_CACHE_TTL_MS = 30s).
     */
    describe('distribution cache (block-change fan-out optimization)', () => {
        it('serves identical (groupId, reward, finder) repeats from cache after first compute', async () => {
            const { service, balanceRepo, groupRepo, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 750);
            await service.recordShare('bc1qbob', 250);

            const balanceFindSpy = jest.spyOn(balanceRepo, 'find');
            const groupFindOneSpy = jest.spyOn(groupRepo, 'findOneBy');

            // First call: computes (PG hits)
            const dist1 = await service.getPayoutDistribution('g1', 100_000_000);
            const balanceCallsAfterFirst = balanceFindSpy.mock.calls.length;
            const groupCallsAfterFirst = groupFindOneSpy.mock.calls.length;
            expect(balanceCallsAfterFirst).toBeGreaterThanOrEqual(1);
            expect(groupCallsAfterFirst).toBeGreaterThanOrEqual(1);

            // Second + third call (same triple): served from cache, NO new PG hits.
            const dist2 = await service.getPayoutDistribution('g1', 100_000_000);
            const dist3 = await service.getPayoutDistribution('g1', 100_000_000);
            expect(balanceFindSpy.mock.calls.length).toBe(balanceCallsAfterFirst);
            expect(groupFindOneSpy.mock.calls.length).toBe(groupCallsAfterFirst);

            // Cache returns the same payouts.
            expect(dist2).toEqual(dist1);
            expect(dist3).toEqual(dist1);
        });

        it('different finderAddress = separate cache entries (per-miner finder bonus)', async () => {
            const { service, groupRepo, balanceRepo, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            const groupFindOneSpy = jest.spyOn(groupRepo, 'findOneBy');
            const balanceFindSpy = jest.spyOn(balanceRepo, 'find');

            // Each unique finder = separate compute (different cache key).
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');
            const callsAfterAlice = groupFindOneSpy.mock.calls.length;

            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qbob');
            const callsAfterBob = groupFindOneSpy.mock.calls.length;

            // Bob's call computed → one MORE groupRepo hit than Alice alone.
            expect(callsAfterBob).toBe(callsAfterAlice + 1);

            // BUT a repeat of Alice → cache hit, no new PG.
            const balanceCallsAfterBob = balanceFindSpy.mock.calls.length;
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');
            expect(balanceFindSpy.mock.calls.length).toBe(balanceCallsAfterBob);
        });

        it('different blockRewardSats invalidates cached entry', async () => {
            const { service, balanceRepo, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 100);

            const balanceFindSpy = jest.spyOn(balanceRepo, 'find');

            await service.getPayoutDistribution('g1', 100_000_000);
            const callsAt100M = balanceFindSpy.mock.calls.length;

            // Different reward = cache miss, recompute.
            await service.getPayoutDistribution('g1', 200_000_000);
            expect(balanceFindSpy.mock.calls.length).toBe(callsAt100M + 1);
        });

        it('round reset (resetRound via wipeRoundState) invalidates the cache', async () => {
            const { service, balanceRepo, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 100);

            const balanceFindSpy = jest.spyOn(balanceRepo, 'find');

            await service.getPayoutDistribution('g1', 100_000_000);
            const callsBeforeReset = balanceFindSpy.mock.calls.length;

            // resetRound is private; trigger it indirectly via the public
            // wipeRoundState path used by scheduledRoundReset.
            await (service as any).resetRound('g1');

            // Re-record shares so the post-reset compute has data
            await service.recordShare('bc1qalice', 100);
            await service.getPayoutDistribution('g1', 100_000_000);
            // Cache was invalidated → recompute → balanceRepo.find got called again.
            expect(balanceFindSpy.mock.calls.length).toBe(callsBeforeReset + 1);
        });

        it('round-best read is served from in-process Map after the first improving share', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 300);
            await service.recordShare('bc1qalice', 700); // new best
            await service.recordShare('bc1qbob', 100);    // not best — no Redis write

            // Three improving moments: first share for alice (cold-start cache
            // miss), bob (no improvement, no write), alice 700 (improvement).
            // 100 from bob never beats 700 → no extra hSet.
            const hSetForBest = (redis.hSet as jest.Mock).mock.calls.filter(
                c => c[0] === 'groupsolo:g1:best-share',
            );
            expect(hSetForBest).toHaveLength(2);

            // getRoundBestDifficulty hits the in-process cache: no HGETALL.
            (redis.hGetAll as jest.Mock).mockClear();
            const best = await service.getRoundBestDifficulty('g1');
            expect(best.bestDifficulty).toBe(700);
            expect(best.address).toBe('bc1qalice');
            expect(redis.hGetAll).not.toHaveBeenCalled();
        });

        it('resetRound drops the in-process round-best cache', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 500);
            (redis.hGetAll as jest.Mock).mockClear();

            await (service as any).resetRound('g1');

            // After reset, no in-process entry → next read falls back to Redis
            // (which is also empty here → zSet cold-start, also empty).
            const best = await service.getRoundBestDifficulty('g1');
            expect(best.bestDifficulty).toBe(0);
        });

        it('coalesces concurrent callers for the same (group, reward, finder) into one build', async () => {
            const { service, balanceRepo, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            // Drop any caches so the next call would compute.
            (service as any).distributionCache.invalidate();
            const balanceFindSpy = jest.spyOn(balanceRepo, 'find');
            balanceFindSpy.mockClear();

            const results = await Promise.all(
                Array.from({ length: 50 }, () =>
                    service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice'),
                ),
            );
            const first = results[0];
            for (const r of results) {
                expect(r).toBe(first);
            }
            expect(balanceFindSpy).toHaveBeenCalledTimes(1);
        });
    });

    it('onBlockFound writes history rows and resets the round', async () => {
        const { service, redis, historyRepo, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);
        enablePerBlockReset(service);
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

    it('onBlockFound keeps the round when resetRoundOnBlock is false (default — accumulate)', async () => {
        const { service, redis, historyRepo, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        // No enablePerBlockReset() → default false → shares accumulate.
        await service.recordShare('bc1qalice', 500);
        await service.getPayoutDistribution('g1', 100_000_000);

        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        // History was still written (the block paid out)…
        expect((historyRepo._rows as any[]).length).toBeGreaterThanOrEqual(1);
        // …but the round aggregate survives for the next block.
        const stats = await service.getRoundStats('g1');
        expect(stats.totalShares).toBe(500);
        expect(parseFloat(redis._hashes.get('groupsolo:g1:by-address')?.get('bc1qalice') ?? '0')).toBe(500);
        // Per-finder snapshots are dropped regardless of the flag.
        for (const [key] of redis._store) {
            expect(key).not.toMatch(/^groupsolo:g1:snapshot:/);
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
        // or appear as rowType='pending'.
        const tinyRows = (historyRepo._rows as any[]).filter(r => r.address === 'bc1qtiny');
        if (tinyRows.length > 0) {
            expect(tinyRows[0].rowType).toBe('pending');
        }
        // Big miner paid via coinbase
        const bigRows = (historyRepo._rows as any[]).filter(r => r.address === 'bc1qbig');
        expect(bigRows.some(r => r.rowType === 'coinbase')).toBe(true);
    });

    it('pending balances accumulate across rounds until they cross dust, then are paid in coinbase', async () => {
        const { service, balanceRepo, historyRepo, groupService } = makeService();
        // Block reward chosen so Charlie's 1-of-1000 share is ~100 sats (well below 546 dust)
        const BLOCK_REWARD = 10_000; // 10k sats
        groupService._setMembership('bc1qbig', 'g1', true);
        groupService._setMembership('bc1qtiny', 'g1', true);
        enablePerBlockReset(service);

        // ── Round 1 ────────────────────────────────────────────────
        await service.recordShare('bc1qbig', 999);
        await service.recordShare('bc1qtiny', 1);
        await service.getPayoutDistribution('g1', BLOCK_REWARD);
        await service.onBlockFound(900_001, BLOCK_REWARD, 'bc1qbig');

        // Charlie's round-1 sats went to pending (sub-dust); Alice was paid via coinbase
        const round1Rows = historyRepo._rows as any[];
        const tinyRound1 = round1Rows.find(r => r.address === 'bc1qtiny' && r.blockHeight === 900_001);
        expect(tinyRound1.rowType).toBe('pending');
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
        expect(tinyRound2.some(r => r.rowType === 'coinbase')).toBe(true);

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
        expect(bobRows[0].rowType).toBe('pending');
        expect(bobRows[0].sharesInRound).toBe(2000);

        // Total paid via coinbase (fee + Alice) should not exceed BLOCK_REWARD
        const coinbasePaid = (historyRepo._rows as any[])
            .filter(r => r.rowType === 'coinbase')
            .reduce((sum, r) => sum + r.paidSats, 0);
        expect(coinbasePaid).toBeLessThanOrEqual(BLOCK_REWARD);
        // And miner-cut portion (non-fee) should not exceed rewardForMiners
        const minerCoinbasePaid = (historyRepo._rows as any[])
            .filter(r => r.rowType === 'coinbase' && r.address !== 'bc1qfee')
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
            .find(r => r.address === 'bc1qalice' && r.rowType === 'coinbase');
        expect(aliceRow).toBeDefined();
        // Single miner with 100% of shares → paidSats ≈ 0.98 * R2 = 117_600_000
        expect(aliceRow.paidSats).toBeGreaterThan(100_000_000);
    });

    it('fallback path honors finder-bonus (regression: parity with snapshot path)', async () => {
        // Pre-refactor, onBlockFoundFromWindow had its own simplified math
        // and silently dropped finder-bonus emission. After the refactor it
        // calls the same buildCoinbaseDistribution as the snapshot path,
        // so the fallback's coinbase shape should match the snapshot's:
        // a dedicated bonus output to the finder, on top of their
        // proportional share.
        //
        // We trigger the fallback via the reward-mismatch guard so the
        // snapshot path is bypassed and the recompute kicks in.
        const { service, historyRepo, groupRepo, groupService } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);

        const BONUS = 50_000;
        groupRepo._rows.push({ id: 'g1', finderBonusSats: BONUS } as any);

        const R1 = 100_000_000;
        await service.recordShare('bc1qalice', 500);
        await service.recordShare('bc1qbob', 500);
        await service.getPayoutDistribution('g1', R1, 'bc1qalice');

        const R2 = 120_000_000;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            // Alice (the finder) wins. The snapshot was built for R1, so
            // the reward-mismatch guard fires and routes to the fallback.
            await service.onBlockFound(900_000, R2, 'bc1qalice');
        } finally {
            warnSpy.mockRestore();
        }

        // Bonus output: a coinbase row for Alice with paidSats ≥ BONUS.
        // Alice has both her proportional row AND (since the bonus is
        // emitted as a separate output) a row with sats == BONUS exactly,
        // OR the proportional row alone if the engine merged them. The
        // current implementation emits two separate outputs, so we expect
        // at least one row that matches the bonus exactly.
        const aliceRows = (historyRepo._rows as any[])
            .filter(r => r.address === 'bc1qalice' && r.rowType === 'coinbase');
        const bonusRow = aliceRows.find(r => r.paidSats === BONUS);
        expect(bonusRow).toBeDefined();

        // Bob (non-finder) gets only his proportional share — half of
        // (R2 - fee - bonus) = half of (120M - 2.4M - 50k) ≈ 58_775_000.
        const bobRow = (historyRepo._rows as any[])
            .find(r => r.address === 'bc1qbob' && r.rowType === 'coinbase');
        expect(bobRow).toBeDefined();
        expect(bobRow.paidSats).toBeGreaterThan(50_000_000);
        expect(bobRow.paidSats).toBeLessThan(60_000_000);

        // Total on-chain miner cut (alice's two rows + bob) MUST equal
        // R2 - fee = 117_600_000 to the sat (no overshoot, no shortage).
        const minerCoinbasePaid = (historyRepo._rows as any[])
            .filter(r => r.rowType === 'coinbase' && r.address !== 'bc1qfee')
            .reduce((sum, r) => sum + r.paidSats, 0);
        const rewardForMiners = Math.floor(0.98 * R2);
        expect(minerCoinbasePaid).toBe(rewardForMiners);
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
        enablePerBlockReset(service);
        await service.recordShare('bc1qalice', 100);
        await service.recordReject('bc1qalice', 50);
        await service.getPayoutDistribution('g1', 100_000_000);

        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        // rejected-shares hash is cleared on round reset; lastAcceptedShareAt
        // is NOT (it survives across rounds, powering the admin kick
        // inactivity gate).
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
        enablePerBlockReset(service);
        await service.recordShare('bc1qalice', 100);
        await service.getPayoutDistribution('g1', 100_000_000);
        await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

        const best = await service.getRoundBestDifficulty('g1');
        expect(best.bestDifficulty).toBe(0);
        expect(best.address).toBeNull();
    });

    /**
     * byAddress hash maintenance — the per-address aggregate that
     * replaces full-window `ZRANGE 0 -1` scans on every read. Must
     * stay in lock-step with the underlying zSet.
     */
    describe('byAddress aggregate hash', () => {
        const KEY = 'groupsolo:g1:by-address';

        it('recordShare populates the byAddress hash', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 100);

            const h = redis._hashes.get(KEY);
            expect(h).toBeDefined();
            expect(parseFloat(h!.get('bc1qalice')!)).toBe(100);
        });

        it('recordShare accumulates per-address diff across calls', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 100);
            await service.recordShare('bc1qalice', 250);
            await service.recordShare('bc1qbob', 75);

            const h = redis._hashes.get(KEY)!;
            expect(parseFloat(h.get('bc1qalice')!)).toBe(350);
            expect(parseFloat(h.get('bc1qbob')!)).toBe(75);
        });

        it('getRoundStats reads from byAddress hash without ZRANGE on the hot path', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 750);
            await service.recordShare('bc1qbob', 250);

            (redis.zRange as jest.Mock).mockClear();
            const stats = await service.getRoundStats('g1');

            expect(redis.zRange).not.toHaveBeenCalled();
            expect(stats.totalShares).toBe(1000);
            const alice = stats.perAddress.find(p => p.address === 'bc1qalice')!;
            expect(alice.totalShares).toBe(750);
            expect(alice.percent).toBeCloseTo(75, 5);
        });

        it('onBlockFound clears the byAddress hash with the rest of the round', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            enablePerBlockReset(service);
            await service.recordShare('bc1qalice', 100);
            await service.getPayoutDistribution('g1', 100_000_000);
            await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

            const h = redis._hashes.get(KEY);
            expect(!h || h.size === 0).toBe(true);
        });

        it('removeMemberState drops the kicked address from byAddress', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            groupService._setMembership('bc1qcharlie', 'g1', true);
            await service.recordShare('bc1qalice', 100);
            await service.recordShare('bc1qbob', 200);
            await service.recordShare('bc1qcharlie', 300);

            await service.removeMemberState('g1', 'bc1qbob', ['bc1qalice', 'bc1qcharlie']);

            const h = redis._hashes.get(KEY)!;
            expect(h.get('bc1qbob')).toBeUndefined();
            expect(parseFloat(h.get('bc1qalice')!)).toBe(100);
            expect(parseFloat(h.get('bc1qcharlie')!)).toBe(300);
        });
    });

    /**
     * bestShare cache — O(1) read for getRoundBestDifficulty, mirrors the
     * byAddress aggregate pattern. Must stay in lock-step with recordShare.
     */
    describe('bestShare cache', () => {
        const KEY = 'groupsolo:g1:best-share';

        it('recordShare seeds the bestShare cache on the first share', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 750);

            const h = redis._hashes.get(KEY)!;
            expect(parseFloat(h.get('diff')!)).toBe(750);
            expect(h.get('address')).toBe('bc1qalice');
            expect(parseInt(h.get('time')!, 10)).toBeGreaterThan(0);
        });

        it('recordShare overwrites the cache only when a higher diff arrives', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            await service.recordShare('bc1qalice', 1000);
            await service.recordShare('bc1qbob', 500);   // lower → no change
            await service.recordShare('bc1qbob', 2000);  // higher → wins

            const h = redis._hashes.get(KEY)!;
            expect(parseFloat(h.get('diff')!)).toBe(2000);
            expect(h.get('address')).toBe('bc1qbob');
        });

        it('getRoundBestDifficulty reads from the cache without ZRANGE on the hot path', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            await service.recordShare('bc1qalice', 1234);

            (redis.zRange as jest.Mock).mockClear();
            const best = await service.getRoundBestDifficulty('g1');

            expect(redis.zRange).not.toHaveBeenCalled();
            expect(best.bestDifficulty).toBe(1234);
            expect(best.address).toBe('bc1qalice');
        });

        it('removeMemberState clears the cache only if the kicked member held the record', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            groupService._setMembership('bc1qcharlie', 'g1', true);
            await service.recordShare('bc1qalice', 100);
            await service.recordShare('bc1qbob', 5000);   // bob holds the record
            await service.recordShare('bc1qcharlie', 200);

            // Kicking a non-holder leaves the cache intact.
            await service.removeMemberState('g1', 'bc1qcharlie', ['bc1qalice', 'bc1qbob']);
            expect(redis._hashes.get(KEY)?.get('address')).toBe('bc1qbob');

            // Kicking the holder drops the cache. With no per-share zSet to
            // recompute from, best-share reads empty until the next share
            // re-seeds it (acceptable: a transient 0 after kicking the leader).
            await service.removeMemberState('g1', 'bc1qbob', ['bc1qalice']);
            expect(redis._hashes.get(KEY)).toBeUndefined();

            const best = await service.getRoundBestDifficulty('g1');
            expect(best.bestDifficulty).toBe(0);
            expect(best.address).toBeNull();
        });

        it('resetRound clears the cache (block-found round wipe)', async () => {
            const { service, redis, groupService } = makeService();
            groupService._setMembership('bc1qalice', 'g1', true);
            enablePerBlockReset(service);
            await service.recordShare('bc1qalice', 999);
            expect(redis._hashes.get(KEY)).toBeDefined();

            await service.getPayoutDistribution('g1', 100_000_000);
            await service.onBlockFound(900_000, 100_000_000, 'bc1qalice');

            expect(redis._hashes.get(KEY)).toBeUndefined();
        });
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
            expect(redis._store.has('groupsolo:g1:last-accepted-share-at')).toBe(false);
            // Snapshots are now keyed per finderAddress (groupsolo:g1:snapshot:<addr>);
            // assert that no snapshot key for this group survives the wipe.
            for (const k of redis._store.keys()) {
                expect(k).not.toMatch(/^groupsolo:g1:snapshot/);
            }

            // ALL pending balances gone (positive forfeit + symmetric)
            expect((balanceRepo._rows as any[]).length).toBe(0);

            // lastRoundResetAt updated
            expect(groupRepo.update).toHaveBeenCalledWith(
                { id: 'g1' },
                expect.objectContaining({ lastRoundResetAt: expect.any(Number) }),
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
                lastRoundResetAt: Date.now() - 30_000,  // 30s ago
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
                dissolvedAt: Date.now(),
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

    it('removeMemberState: kick redistribution stamps lastAcceptedShareAt on recipients (regression: dust-sweep protection)', async () => {
        // The dust-sweep cron absorbs pending rows whose pendingSats <
        // minPayout AND lastAcceptedShareAt < dormancyCutoff. Pre-fix,
        // addPending didn't touch lastAcceptedShareAt — so a kick that
        // redistributed sats to a recipient with a stale (or null)
        // timestamp would let the very next sweep absorb the just-credited
        // sats. The fix stamps now() on every credit.
        const { service, groupService, balanceRepo } = makeService();
        groupService._setMembership('bc1qalice', 'g1', true);
        groupService._setMembership('bc1qbob', 'g1', true);

        const STALE = Date.parse('2020-01-01T00:00:00Z');

        // Seed: bob has 900 sats pending; alice has a stale balance row
        // (mined long ago, dust-eligible by timestamp).
        (balanceRepo._rows as any[]).push(
            { address: 'bc1qbob', groupId: 'g1', pendingSats: 900, totalPaidSats: 0,
              lastAcceptedShareAt: Date.now() },
            { address: 'bc1qalice', groupId: 'g1', pendingSats: 100, totalPaidSats: 0,
              lastAcceptedShareAt: STALE },
        );

        const before = Date.now();
        await service.removeMemberState('g1', 'bc1qbob', ['bc1qalice']);
        const after = Date.now();

        const aliceRow = (balanceRepo._rows as any[]).find(r => r.address === 'bc1qalice');
        expect(aliceRow?.pendingSats).toBe(1000); // 100 existing + 900 redistributed
        // Timestamp must have been refreshed inside the kick window —
        // not left at STALE — otherwise the next sweep cron run would
        // immediately absorb the just-credited 900 sats.
        expect(typeof aliceRow?.lastAcceptedShareAt).toBe('number');
        expect(aliceRow.lastAcceptedShareAt).toBeGreaterThanOrEqual(before);
        expect(aliceRow.lastAcceptedShareAt).toBeLessThanOrEqual(after);
    });

    // ── Finder-bonus per-miner coinbase ────────────────────────────
    //
    // The bonus output is built into each miner's own coinbase template
    // (their address as recipient). The proportional split is computed
    // on the post-bonus miner cut, so the finder's total is
    //     bonus + their_proportional_share_of_(reward - bonus).
    // Other members' shares shrink proportionally — they "pay" for the
    // bonus in the sense that their slice of the pie is smaller than
    // it would be without the bonus. Each miner's snapshot is keyed by
    // their finderAddress so onBlockFound matches the on-chain coinbase
    // exactly.
    describe('finder bonus (per-miner coinbase)', () => {
        const FINDER_BONUS = 1_000_000; // 0.01 BTC

        const seedGroup = (
            service: any,
            groupRepo: any,
            groupId: string,
            finderBonusSats: number | null,
        ) => {
            (groupRepo._rows as any[]).push({
                id: groupId,
                name: groupId,
                creatorAddress: 'bc1qalice',
                adminTokenHash: 'x',
                rules: '',
                forbidBuyHashrate: false,
                roundResetIntervalDays: null,
                roundResetHourLocal: null,
                roundResetTimezone: null,
                lastRoundResetAt: null,
                finderBonusSats,
                dissolvedAt: null,
                createdAt: Date.now(),
            });
        };

        it('emits a dedicated bonus output to finderAddress when configured', async () => {
            const { service, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', FINDER_BONUS);
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            // Build alice's per-miner coinbase template.
            const dist = await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');

            // Alice should appear at least once: once for her bonus output
            // (FINDER_BONUS sats) and once (or merged) for her proportional
            // share. The current impl emits them as separate outputs — find
            // the dedicated bonus entry by exact-match on the configured sats.
            const aliceOutputs = dist.filter(d => d.address === 'bc1qalice');
            const bonusOutput = aliceOutputs.find(d => d.sats === FINDER_BONUS);
            expect(bonusOutput).toBeDefined();

            // Total miner-portion (non-fee) should not exceed
            //   floor((100 - feePercent)/100 * blockReward) = 98_000_000.
            const minerCut = dist
                .filter(d => d.address !== 'bc1qfee')
                .reduce((s, d) => s + d.sats, 0);
            expect(minerCut).toBeLessThanOrEqual(98_000_000);

            // Alice's effective total = bonus + her proportional share of
            // (rewardForMiners - bonus). With 50/50 shares, she should get
            // bonus + ~half of (98M - bonus) = 1M + 48.5M ≈ 49.5M sats.
            const aliceTotal = aliceOutputs.reduce((s, d) => s + d.sats, 0);
            expect(aliceTotal).toBeGreaterThan(FINDER_BONUS);
            expect(aliceTotal).toBeLessThan(98_000_000);
            // Bob keeps roughly half the post-bonus miner cut.
            const bobTotal = dist
                .filter(d => d.address === 'bc1qbob')
                .reduce((s, d) => s + d.sats, 0);
            expect(bobTotal).toBeGreaterThan(0);
            expect(bobTotal).toBeLessThan(aliceTotal); // alice has the bonus on top
        });

        it('per-miner snapshots: each miner gets their own coinbase keyed by their address', async () => {
            const { service, redis, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', FINDER_BONUS);
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            // Build per-miner templates for alice and bob — each writes
            // a snapshot keyed by their own address.
            const distAlice = await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');
            const distBob   = await service.getPayoutDistribution('g1', 100_000_000, 'bc1qbob');

            // Two distinct snapshots persisted in Redis, each with the
            // bonus output to its respective finder.
            expect(redis._hashes.has('groupsolo:g1:snapshot:bc1qalice')).toBe(true);
            expect(redis._hashes.has('groupsolo:g1:snapshot:bc1qbob')).toBe(true);

            const aliceSnap = await readStoredSnapshot(redis, 'groupsolo:g1:snapshot:bc1qalice');
            const bobSnap = await readStoredSnapshot(redis, 'groupsolo:g1:snapshot:bc1qbob');

            const aliceBonus = aliceSnap!.distribution.find(d => d.address === 'bc1qalice' && d.sats === FINDER_BONUS);
            const bobBonus   = bobSnap!.distribution.find(d => d.address === 'bc1qbob'   && d.sats === FINDER_BONUS);
            expect(aliceBonus).toBeDefined();
            expect(bobBonus).toBeDefined();
        });

        it('onBlockFound reads the snapshot for the actual finder', async () => {
            const { service, redis, historyRepo, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', FINDER_BONUS);
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            // Both miners build their own templates first.
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qbob');

            // Bob finds the block. Accounting must use bob's snapshot, not alice's.
            await service.onBlockFound(900_000, 100_000_000, 'bc1qbob');

            // Bob should have a coinbase row with at least the bonus amount.
            const bobCoinbaseRows = (historyRepo._rows as any[])
                .filter(r => r.address === 'bc1qbob' && r.rowType === 'coinbase');
            expect(bobCoinbaseRows.length).toBeGreaterThan(0);
            const bobTotalPaid = bobCoinbaseRows.reduce((s, r) => s + r.paidSats, 0);
            expect(bobTotalPaid).toBeGreaterThanOrEqual(FINDER_BONUS);

            // Alice should NOT have a bonus output in this block — only
            // her proportional share. Her on-chain payout must be smaller
            // than bob's because bob has the bonus on top.
            const aliceCoinbaseRows = (historyRepo._rows as any[])
                .filter(r => r.address === 'bc1qalice' && r.rowType === 'coinbase');
            const aliceTotalPaid = aliceCoinbaseRows.reduce((s, r) => s + r.paidSats, 0);
            expect(aliceTotalPaid).toBeLessThan(bobTotalPaid);

            // Round resets — all per-finder snapshots cleared.
            for (const k of redis._hashes.keys()) {
                expect(k).not.toMatch(/^groupsolo:g1:snapshot/);
            }
        });

        it('no bonus output when finderBonusSats=0 — old path preserved', async () => {
            const { service, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', 0);
            groupService._setMembership('bc1qalice', 'g1', true);

            await service.recordShare('bc1qalice', 1000);

            const dist = await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');

            // Just fee + alice's proportional share; no extra bonus output.
            // With single miner the proportional share already concentrates
            // the whole miner cut to her, so the dist length stays the same
            // as the old code path: 2 outputs (fee + alice).
            expect(dist).toHaveLength(2);
            expect(dist.find(d => d.address === 'bc1qfee')).toBeDefined();
            const alice = dist.find(d => d.address === 'bc1qalice')!;
            // Alice gets ~98% (full miner cut), no separate bonus output.
            expect(alice.percent).toBeCloseTo(98, 1);
        });

        it('no bonus output when finderAddress is undefined — graceful fallback', async () => {
            const { service, redis, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', FINDER_BONUS);
            groupService._setMembership('bc1qalice', 'g1', true);

            await service.recordShare('bc1qalice', 1000);

            // No finderAddress provided (e.g. unauthenticated stratum session)
            const dist = await service.getPayoutDistribution('g1', 100_000_000);

            // No dedicated bonus output emitted; falls back to fee + prop split.
            // Snapshot is stored under the legacy "__none__" suffix so a
            // legacy onBlockFound caller (or graceful upgrade) can find it.
            expect(redis._hashes.has('groupsolo:g1:snapshot:__none__')).toBe(true);
            const alice = dist.find(d => d.address === 'bc1qalice')!;
            // Same shape as the no-bonus case above — full miner cut to alice.
            expect(alice.percent).toBeCloseTo(98, 1);
            // Alice's output shouldn't equal FINDER_BONUS exactly (would
            // indicate the bonus was emitted despite missing finderAddress).
            expect(alice.sats).not.toBe(FINDER_BONUS);
        });

        it('bonus capped at 95% of miner cut — small post-halving block stays solvable', async () => {
            const { service, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            // Configure a giant bonus (1 BTC) on a small block reward — the
            // 95 % cap must kick in so the rest of the group isn't starved
            // and the math doesn't blow past the miner cut.
            seedGroup(service, groupRepo, 'g1', 100_000_000); // 1 BTC bonus
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);

            await service.recordShare('bc1qalice', 500);
            await service.recordShare('bc1qbob', 500);

            const SMALL_REWARD = 50_000_000; // 0.5 BTC — bonus larger than the block reward
            const dist = await service.getPayoutDistribution('g1', SMALL_REWARD, 'bc1qalice');

            // Total emitted (incl. fee) must not exceed the block reward —
            // otherwise Bitcoin Core rejects with bad-cb-amount.
            const totalEmitted = dist.reduce((s, d) => s + d.sats, 0);
            expect(totalEmitted).toBeLessThanOrEqual(SMALL_REWARD);

            // 95 % cap of miner cut (~49M sats) — alice's bonus output
            // shouldn't exceed that.
            const minerCut = SMALL_REWARD - Math.floor(0.02 * SMALL_REWARD); // 49M
            const cap = Math.floor(minerCut * 0.95);
            const aliceBonus = dist.find(d => d.address === 'bc1qalice' && d.sats <= cap);
            expect(aliceBonus).toBeDefined();
        });

        it('per-miner snapshots all wiped after onBlockFound — no stale state for next round', async () => {
            const { service, redis, groupService } = makeService();
            const groupRepo = (service as any).groupRepo;
            seedGroup(service, groupRepo, 'g1', FINDER_BONUS);
            groupService._setMembership('bc1qalice', 'g1', true);
            groupService._setMembership('bc1qbob', 'g1', true);
            groupService._setMembership('bc1qcharlie', 'g1', true);

            await service.recordShare('bc1qalice', 100);
            await service.recordShare('bc1qbob', 100);
            await service.recordShare('bc1qcharlie', 100);

            // 3 per-miner templates → 3 snapshots in Redis.
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qalice');
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qbob');
            await service.getPayoutDistribution('g1', 100_000_000, 'bc1qcharlie');

            const snapshotKeysBefore = Array.from(redis._hashes.keys()).filter(k => k.startsWith('groupsolo:g1:snapshot'));
            expect(snapshotKeysBefore.length).toBe(3);

            // Charlie finds the block.
            await service.onBlockFound(900_000, 100_000_000, 'bc1qcharlie');

            // All 3 snapshots are now stale (round reset) → wiped.
            const snapshotKeysAfter = Array.from(redis._hashes.keys()).filter(k => k.startsWith('groupsolo:g1:snapshot'));
            expect(snapshotKeysAfter.length).toBe(0);
        });
    });

    describe('legacy per-share key cleanup', () => {
        it('reclaims orphaned :shares + :counter on startup, keeps live keys', async () => {
            const { service, redis } = makeService();

            // Orphaned legacy keys (no longer written/read by the new code).
            redis._zsets.set('groupsolo:g1:shares', [{ score: 1, value: 'bc1qa:100' }]);
            redis._zsets.set('groupsolo:g2:shares', [{ score: 1, value: 'bc1qb:200' }]);
            redis._store.set('groupsolo:g1:counter', '5');
            // Live keys that MUST survive — note rejected-shares ends in
            // `-shares`, so the `*:shares` glob must NOT catch it.
            redis._hashes.set('groupsolo:g1:by-address', new Map([['bc1qa', '100']]));
            redis._hashes.set('groupsolo:g1:rejected-shares', new Map([['bc1qa', '5']]));
            redis._store.set('groupsolo:g1:total', '100');

            await (service as any).cleanupLegacyShareKeys();

            // Orphans gone.
            expect(redis._zsets.has('groupsolo:g1:shares')).toBe(false);
            expect(redis._zsets.has('groupsolo:g2:shares')).toBe(false);
            expect(redis._store.has('groupsolo:g1:counter')).toBe(false);
            // Live keys untouched.
            expect(redis._hashes.has('groupsolo:g1:by-address')).toBe(true);
            expect(redis._hashes.has('groupsolo:g1:rejected-shares')).toBe(true);
            expect(redis._store.has('groupsolo:g1:total')).toBe(true);
        });

        it('is a no-op when there are no legacy keys', async () => {
            const { service, redis } = makeService();
            redis._hashes.set('groupsolo:g1:by-address', new Map([['bc1qa', '100']]));
            await (service as any).cleanupLegacyShareKeys();
            expect(redis._hashes.has('groupsolo:g1:by-address')).toBe(true);
        });

        it('skips the scan on later restarts once the done-flag is set', async () => {
            const { service, redis } = makeService();
            // First run cleans + sets the flag.
            redis._zsets.set('groupsolo:g1:shares', [{ score: 1, value: 'bc1qa:100' }]);
            await (service as any).cleanupLegacyShareKeys();
            expect(redis._zsets.has('groupsolo:g1:shares')).toBe(false);
            expect(redis._store.get('groupsolo:legacy-share-cleanup-done')).toBe('1');

            // A later call short-circuits on the flag — a stray orphan is NOT
            // scanned/removed (proves later restarts cost just the GET).
            redis._zsets.set('groupsolo:g9:shares', [{ score: 1, value: 'bc1qz:1' }]);
            await (service as any).cleanupLegacyShareKeys();
            expect(redis._zsets.has('groupsolo:g9:shares')).toBe(true);
        });
    });
});
