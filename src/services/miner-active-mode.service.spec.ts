import { MinerActiveModeService } from './miner-active-mode.service';

/**
 * The mark() hot path used to issue a Redis SET per accepted share — at
 * ~6 shares/min/address × 364 active addresses observed on prod, that's
 * ~36 writes/sec, 99 %+ of which refresh the same value to the same TTL.
 * Debounce keeps one write per minute per (address, mode) and always
 * writes when the mode changes (port-switch detection).
 */
function buildService(redis: any) {
    const cacheManager = { store: { client: redis } } as any;
    const service = new MinerActiveModeService(cacheManager);
    service.onModuleInit();
    return service;
}

describe('MinerActiveModeService.mark — debounce', () => {
    it('writes once on the first mark', async () => {
        const set = jest.fn().mockResolvedValue('OK');
        const service = buildService({ set });
        await service.mark('addr-A', 'solo');
        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith('miner:addr-A:mode', 'solo', { EX: 300 });
    });

    it('skips the Redis write when the same mode is marked again within 60s', async () => {
        const set = jest.fn().mockResolvedValue('OK');
        const service = buildService({ set });
        await service.mark('addr-A', 'solo');
        await service.mark('addr-A', 'solo');
        await service.mark('addr-A', 'solo');
        expect(set).toHaveBeenCalledTimes(1);
    });

    it('always writes when the mode changes regardless of debounce window', async () => {
        const set = jest.fn().mockResolvedValue('OK');
        const service = buildService({ set });
        await service.mark('addr-A', 'pplns');
        await service.mark('addr-A', 'group-solo');
        await service.mark('addr-A', 'solo');
        expect(set).toHaveBeenCalledTimes(3);
        expect(set.mock.calls.map(c => c[1])).toEqual(['pplns', 'group-solo', 'solo']);
    });

    it('refreshes again after REFRESH_INTERVAL_MS has elapsed', async () => {
        jest.useFakeTimers();
        try {
            const set = jest.fn().mockResolvedValue('OK');
            const service = buildService({ set });
            await service.mark('addr-A', 'pplns');
            jest.setSystemTime(Date.now() + 30_000);
            await service.mark('addr-A', 'pplns'); // still inside debounce
            expect(set).toHaveBeenCalledTimes(1);
            jest.setSystemTime(Date.now() + 31_000); // past 60s total
            await service.mark('addr-A', 'pplns');
            expect(set).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('debounces per address independently', async () => {
        const set = jest.fn().mockResolvedValue('OK');
        const service = buildService({ set });
        await service.mark('addr-A', 'solo');
        await service.mark('addr-B', 'solo');
        await service.mark('addr-A', 'solo'); // debounced
        await service.mark('addr-B', 'solo'); // debounced
        expect(set).toHaveBeenCalledTimes(2);
    });

    it('falls back to set + expire on options-form error and still marks the cache', async () => {
        const set = jest.fn()
            .mockRejectedValueOnce(new Error('no options form'))
            .mockResolvedValueOnce('OK');
        const expire = jest.fn().mockResolvedValue(1);
        const service = buildService({ set, expire });
        await service.mark('addr-A', 'solo');
        expect(set).toHaveBeenCalledTimes(2);
        expect(expire).toHaveBeenCalledWith('miner:addr-A:mode', 300);
        // Subsequent mark within window should now skip.
        await service.mark('addr-A', 'solo');
        expect(set).toHaveBeenCalledTimes(2);
    });

    it('does not poison the debounce cache on total failure', async () => {
        const set = jest.fn().mockRejectedValue(new Error('Redis down'));
        const service = buildService({ set }); // no expire → fallback also rejects
        await service.mark('addr-A', 'solo');
        // Both attempts failed; next mark should try again rather than skipping.
        await service.mark('addr-A', 'solo');
        expect(set.mock.calls.length).toBeGreaterThan(2);
    });
});

describe('MinerActiveModeService.get', () => {
    it('returns the raw value when it matches a valid mode', async () => {
        const get = jest.fn().mockResolvedValue('pplns');
        const service = buildService({ get, set: jest.fn() });
        expect(await service.get('addr-A')).toBe('pplns');
        expect(get).toHaveBeenCalledWith('miner:addr-A:mode');
    });

    it('returns null for an unknown / expired key', async () => {
        const get = jest.fn().mockResolvedValue(null);
        const service = buildService({ get, set: jest.fn() });
        expect(await service.get('addr-A')).toBeNull();
    });
});
