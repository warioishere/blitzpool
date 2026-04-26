import {
    readStoredSnapshot,
    writeStoredSnapshot,
    StoredCoinbaseSnapshot,
} from './coinbase-snapshot';

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string, _opts?: any) => {
            store.set(key, value);
        }),
        expire: jest.fn(async (_key: string, _ttl: number) => 1),
        del: jest.fn(async (key: string) => { store.delete(key); }),
        _store: store,
    };
}

describe('coinbase-snapshot', () => {
    const KEY = 'pplns:snapshot';
    const TTL = 3600;

    describe('writeStoredSnapshot', () => {
        it('serializes the snapshot and uses SET … EX when supported', async () => {
            const redis = createMockRedis();
            const snapshot: StoredCoinbaseSnapshot = {
                distribution: [{ address: 'bc1qfee', percent: 2, sats: 200 }],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice'],
                balanceAfter: [['bc1qalice', 50]],
            };

            await writeStoredSnapshot(redis as any, KEY, snapshot, TTL);

            expect(redis.set).toHaveBeenCalledWith(KEY, JSON.stringify(snapshot), { EX: TTL });
            expect(redis.expire).not.toHaveBeenCalled();
            expect(redis._store.get(KEY)).toBe(JSON.stringify(snapshot));
        });

        it('falls back to SET + EXPIRE when SET … EX throws (legacy ioredis)', async () => {
            const store = new Map<string, string>();
            // First SET call (with options) throws; second succeeds.
            const set = jest.fn()
                .mockImplementationOnce(async () => { throw new Error('options not supported'); })
                .mockImplementationOnce(async (k: string, v: string) => { store.set(k, v); });
            const redis: any = {
                set,
                expire: jest.fn(async () => 1),
            };
            const snapshot: StoredCoinbaseSnapshot = {
                distribution: [],
                blockRewardSats: 100,
                consideredAddresses: [],
                balanceAfter: [],
            };

            await writeStoredSnapshot(redis, KEY, snapshot, TTL);

            expect(set).toHaveBeenCalledTimes(2);
            expect(redis.expire).toHaveBeenCalledWith(KEY, TTL);
            expect(store.get(KEY)).toBe(JSON.stringify(snapshot));
        });
    });

    describe('readStoredSnapshot', () => {
        it('returns null when the key is missing', async () => {
            const redis = createMockRedis();
            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result).toBeNull();
        });

        it('hydrates consideredAddresses → Set and balanceAfter → Map', async () => {
            const redis = createMockRedis();
            const snapshot: StoredCoinbaseSnapshot = {
                distribution: [
                    { address: 'bc1qfee', percent: 2, sats: 200 },
                    { address: 'bc1qalice', percent: 98, sats: 9800 },
                ],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice', 'bc1qbob'],
                balanceAfter: [['bc1qalice', 50], ['bc1qbob', -50]],
            };
            redis._store.set(KEY, JSON.stringify(snapshot));

            const result = await readStoredSnapshot(redis as any, KEY);

            expect(result).not.toBeNull();
            expect(result!.distribution).toEqual(snapshot.distribution);
            expect(result!.blockRewardSats).toBe(10000);
            expect(result!.consideredAddresses).toBeInstanceOf(Set);
            expect(result!.consideredAddresses.has('bc1qalice')).toBe(true);
            expect(result!.consideredAddresses.has('bc1qbob')).toBe(true);
            expect(result!.balanceAfter).toBeInstanceOf(Map);
            expect(result!.balanceAfter.get('bc1qalice')).toBe(50);
            expect(result!.balanceAfter.get('bc1qbob')).toBe(-50);
        });

        it('derives sats from percent for legacy snapshots that pre-date the signed-ledger rollout', async () => {
            const redis = createMockRedis();
            // Stored shape lacks `sats` — written by an older code version.
            const legacy = {
                distribution: [
                    { address: 'bc1qfee', percent: 2 },
                    { address: 'bc1qalice', percent: 98 },
                ],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice'],
                balanceAfter: [],
            };
            redis._store.set(KEY, JSON.stringify(legacy));

            const result = await readStoredSnapshot(redis as any, KEY);

            expect(result).not.toBeNull();
            // floor(2/100 * 10000) = 200 ; floor(98/100 * 10000) = 9800
            expect(result!.distribution[0].sats).toBe(200);
            expect(result!.distribution[1].sats).toBe(9800);
        });

        it('returns null on unparseable JSON instead of throwing', async () => {
            const redis = createMockRedis();
            redis._store.set(KEY, '{not valid json');
            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result).toBeNull();
        });

        it('roundtrips: write then read produces an equivalent payload', async () => {
            const redis = createMockRedis();
            const snapshot: StoredCoinbaseSnapshot = {
                distribution: [{ address: 'bc1qfee', percent: 2, sats: 200 }],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice'],
                balanceAfter: [['bc1qalice', 50]],
            };

            await writeStoredSnapshot(redis as any, KEY, snapshot, TTL);
            const result = await readStoredSnapshot(redis as any, KEY);

            expect(result).not.toBeNull();
            expect(result!.distribution).toEqual(snapshot.distribution);
            expect(result!.blockRewardSats).toBe(snapshot.blockRewardSats);
            expect(Array.from(result!.consideredAddresses)).toEqual(snapshot.consideredAddresses);
            expect(Array.from(result!.balanceAfter.entries())).toEqual(snapshot.balanceAfter);
        });
    });
});
