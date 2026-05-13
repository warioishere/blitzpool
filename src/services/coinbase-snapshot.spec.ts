import {
    readStoredSnapshot,
    writeStoredSnapshot,
    StoredCoinbaseSnapshot,
} from './coinbase-snapshot';

/**
 * Mock Redis that supports both the new Hash path and the legacy
 * STRING path used as a backwards-compat fallback. del() removes any
 * type of value so the round-trip flow works.
 */
function createMockRedis() {
    const strings = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    return {
        get: jest.fn(async (key: string) => strings.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            hashes.delete(key);
            strings.set(key, value);
        }),
        hSet: jest.fn(async (key: string, fields: Record<string, string>) => {
            strings.delete(key);
            const existing = hashes.get(key) ?? {};
            Object.assign(existing, fields);
            hashes.set(key, existing);
            return Object.keys(fields).length;
        }),
        hGetAll: jest.fn(async (key: string) => {
            if (strings.has(key)) {
                // Real Redis would throw WRONGTYPE here; emulate.
                throw new Error('WRONGTYPE');
            }
            return hashes.get(key) ?? {};
        }),
        del: jest.fn(async (key: string) => {
            const had = strings.delete(key) || hashes.delete(key);
            return had ? 1 : 0;
        }),
        expire: jest.fn(async (_key: string, _ttl: number) => 1),
        _strings: strings,
        _hashes: hashes,
    };
}

describe('coinbase-snapshot', () => {
    const KEY = 'pplns:snapshot';
    const TTL = 3600;

    describe('writeStoredSnapshot', () => {
        it('writes the snapshot as a Redis Hash with per-field layout', async () => {
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

            await writeStoredSnapshot(redis as any, KEY, snapshot, TTL);

            expect(redis.del).toHaveBeenCalledWith(KEY);
            expect(redis.hSet).toHaveBeenCalledTimes(1);
            expect(redis.expire).toHaveBeenCalledWith(KEY, TTL);

            const hash = redis._hashes.get(KEY)!;
            expect(hash.blockRewardSats).toBe('10000');
            expect(hash.distribution_count).toBe('2');
            expect(hash.balanceAfter_count).toBe('2');
            expect(hash.consideredAddresses).toBe('bc1qalice|bc1qbob');
            expect(hash.d0_addr).toBe('bc1qfee');
            expect(hash.d0_pct).toBe('2');
            expect(hash.d0_sats).toBe('200');
            expect(hash.d1_addr).toBe('bc1qalice');
            expect(hash.d1_sats).toBe('9800');
            expect(hash.b0_addr).toBe('bc1qalice');
            expect(hash.b0_sats).toBe('50');
            expect(hash.b1_addr).toBe('bc1qbob');
            expect(hash.b1_sats).toBe('-50');
        });

        it('overwrites a legacy JSON-blob (STRING) snapshot in place', async () => {
            const redis = createMockRedis();
            redis._strings.set(KEY, '{"legacy":"json"}');

            const snapshot: StoredCoinbaseSnapshot = {
                distribution: [],
                blockRewardSats: 100,
                consideredAddresses: [],
                balanceAfter: [],
            };
            await writeStoredSnapshot(redis as any, KEY, snapshot, TTL);

            expect(redis._strings.has(KEY)).toBe(false);
            expect(redis._hashes.has(KEY)).toBe(true);
        });
    });

    describe('readStoredSnapshot', () => {
        it('returns null when the key is missing', async () => {
            const redis = createMockRedis();
            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result).toBeNull();
        });

        it('hydrates a Hash snapshot back to Set / Map / array form', async () => {
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
            await writeStoredSnapshot(redis as any, KEY, snapshot, TTL);

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

        it('hydrates an empty distribution + empty balance set correctly', async () => {
            const redis = createMockRedis();
            await writeStoredSnapshot(redis as any, KEY, {
                distribution: [],
                blockRewardSats: 5000,
                consideredAddresses: [],
                balanceAfter: [],
            }, TTL);

            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result).not.toBeNull();
            expect(result!.distribution).toEqual([]);
            expect(result!.blockRewardSats).toBe(5000);
            expect(result!.consideredAddresses.size).toBe(0);
            expect(result!.balanceAfter.size).toBe(0);
        });

        it('large distribution (500 entries) round-trips correctly', async () => {
            const redis = createMockRedis();
            const distribution: StoredCoinbaseSnapshot['distribution'] = [];
            for (let i = 0; i < 500; i++) {
                distribution.push({ address: `bc1qaddr${i}`, percent: 0.2, sats: 20 });
            }
            await writeStoredSnapshot(redis as any, KEY, {
                distribution,
                blockRewardSats: 10000,
                consideredAddresses: distribution.map(d => d.address),
                balanceAfter: distribution.map(d => [d.address, 100] as [string, number]),
            }, TTL);

            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result!.distribution).toHaveLength(500);
            expect(result!.distribution[0]).toEqual({ address: 'bc1qaddr0', percent: 0.2, sats: 20 });
            expect(result!.distribution[499]).toEqual({ address: 'bc1qaddr499', percent: 0.2, sats: 20 });
            expect(result!.consideredAddresses.size).toBe(500);
            expect(result!.balanceAfter.get('bc1qaddr250')).toBe(100);
        });

        it('falls back to legacy JSON-blob format if the key was a STRING', async () => {
            // Simulates an in-flight snapshot written by the pre-Hash deploy.
            // After the new deploy, the reader must still hydrate it correctly
            // for the first ~1h until TTL expires.
            const redis = createMockRedis();
            const legacy = {
                distribution: [{ address: 'bc1qfee', percent: 2, sats: 200 }],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice'],
                balanceAfter: [['bc1qalice', 50]],
            };
            redis._strings.set(KEY, JSON.stringify(legacy));

            const result = await readStoredSnapshot(redis as any, KEY);

            expect(result).not.toBeNull();
            expect(result!.distribution).toEqual(legacy.distribution);
            expect(result!.consideredAddresses.has('bc1qalice')).toBe(true);
            expect(result!.balanceAfter.get('bc1qalice')).toBe(50);
        });

        it('legacy JSON fallback derives sats from percent for pre-signed-ledger snapshots', async () => {
            const redis = createMockRedis();
            const legacy = {
                distribution: [
                    { address: 'bc1qfee', percent: 2 },
                    { address: 'bc1qalice', percent: 98 },
                ],
                blockRewardSats: 10000,
                consideredAddresses: ['bc1qalice'],
                balanceAfter: [],
            };
            redis._strings.set(KEY, JSON.stringify(legacy));

            const result = await readStoredSnapshot(redis as any, KEY);

            expect(result).not.toBeNull();
            expect(result!.distribution[0].sats).toBe(200);
            expect(result!.distribution[1].sats).toBe(9800);
        });

        it('returns null on unparseable legacy JSON instead of throwing', async () => {
            const redis = createMockRedis();
            redis._strings.set(KEY, '{not valid json');
            const result = await readStoredSnapshot(redis as any, KEY);
            expect(result).toBeNull();
        });
    });
});
