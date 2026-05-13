import { InflightResultCache } from './inflight-result-cache';

describe('InflightResultCache', () => {
    it('first call computes, second call within TTL returns cached', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        const build = jest.fn(async () => 42);
        const a = await cache.getOrCompute('k', build);
        const b = await cache.getOrCompute('k', build);
        expect(a).toBe(42);
        expect(b).toBe(42);
        expect(build).toHaveBeenCalledTimes(1);
    });

    it('concurrent callers share one build (in-flight dedup)', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        let resolve: ((v: number) => void) | null = null;
        const build = jest.fn(() => new Promise<number>(r => { resolve = r; }));
        const p1 = cache.getOrCompute('k', build);
        const p2 = cache.getOrCompute('k', build);
        const p3 = cache.getOrCompute('k', build);
        resolve!(99);
        expect(await p1).toBe(99);
        expect(await p2).toBe(99);
        expect(await p3).toBe(99);
        expect(build).toHaveBeenCalledTimes(1);
    });

    it('different keys do not share state', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        await cache.getOrCompute('a', async () => 1);
        await cache.getOrCompute('b', async () => 2);
        expect(cache.peek('a')).toBe(1);
        expect(cache.peek('b')).toBe(2);
    });

    it('recomputes after TTL elapses', async () => {
        jest.useFakeTimers();
        try {
            const cache = new InflightResultCache<string, number>(30_000);
            const build = jest.fn(async () => 1);
            await cache.getOrCompute('k', build);
            jest.setSystemTime(Date.now() + 31_000);
            await cache.getOrCompute('k', build);
            expect(build).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('build failure clears in-flight; next caller retries', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        let n = 0;
        const build = jest.fn(async () => {
            n++;
            if (n === 1) throw new Error('boom');
            return 7;
        });
        await expect(cache.getOrCompute('k', build)).rejects.toThrow('boom');
        await expect(cache.getOrCompute('k', build)).resolves.toBe(7);
        expect(build).toHaveBeenCalledTimes(2);
    });

    it('invalidate() with no arg clears all', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        await cache.getOrCompute('a', async () => 1);
        await cache.getOrCompute('b', async () => 2);
        cache.invalidate();
        expect(cache.peek('a')).toBeNull();
        expect(cache.peek('b')).toBeNull();
    });

    it('invalidate(key) drops just that one', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        await cache.getOrCompute('a', async () => 1);
        await cache.getOrCompute('b', async () => 2);
        cache.invalidate('a');
        expect(cache.peek('a')).toBeNull();
        expect(cache.peek('b')).toBe(2);
    });

    it('invalidate(predicate) drops keys matching it', async () => {
        const cache = new InflightResultCache<string, number>(30_000);
        await cache.getOrCompute('grp1:alice', async () => 1);
        await cache.getOrCompute('grp1:bob', async () => 2);
        await cache.getOrCompute('grp2:carol', async () => 3);
        cache.invalidate(k => k.startsWith('grp1:'));
        expect(cache.peek('grp1:alice')).toBeNull();
        expect(cache.peek('grp1:bob')).toBeNull();
        expect(cache.peek('grp2:carol')).toBe(3);
    });
});
