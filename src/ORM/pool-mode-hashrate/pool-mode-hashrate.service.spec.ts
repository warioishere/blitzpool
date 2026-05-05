jest.mock('node-telegram-bot-api', () => jest.fn());

import { PoolModeHashrateService } from './pool-mode-hashrate.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { DIFFICULTY_1, MAX_REASONABLE_DIFFICULTY } from '../../constants/mining.constants';

/**
 * These tests pin two invariants:
 *
 *   1. Writes go through Redis only — no per-share PG hit. Rewriting this
 *      service to call repo.increment() per share was what created the
 *      production lock-contention hotspot on 2026-05-05 (3 hot rows on
 *      `pool_mode_hashrate` × ~250 shares/s starved the 10-conn PG pool
 *      and bled into other coordinator flushes). Coordinator picks up
 *      the Redis hash and bulk-upserts to PG every 60s.
 *
 *   2. The chart read MUST keep using the same slot convention (end-time,
 *      via TimeSlotHelper) and the same current-slot-exclusion filter as
 *      ClientStatisticsService.getChartDataForSite. Reinventing a
 *      Math.floor/BUCKET_MS scheme caused the original "PPLNS curve
 *      doesn't match total" 10-min divergence.
 */

function makeRepo(chartRows: any[]) {
    return {
        createQueryBuilder: (_alias: string) => {
            const captured: Record<string, any> = {};
            const qb: any = {
                select: () => qb,
                addSelect: () => qb,
                where: (_expr: string, params: any) => { Object.assign(captured, params); return qb; },
                andWhere: (_expr: string, params: any) => { Object.assign(captured, params); return qb; },
                orderBy: () => qb,
                limit: () => qb,
                getRawMany: async () => {
                    (qb as any)._captured = captured;
                    return chartRows;
                },
                _captured: captured,
            };
            return qb;
        },
    };
}

function makeCacheManager(redisClient: any) {
    return { store: { client: redisClient } };
}

describe('PoolModeHashrateService', () => {

    describe('incrementAccepted (Redis-buffer write path)', () => {
        let mockRedis: any;
        let service: PoolModeHashrateService;

        beforeEach(async () => {
            mockRedis = {
                hIncrByFloat: jest.fn().mockResolvedValue(undefined),
                expire: jest.fn().mockResolvedValue(undefined),
            };
            const repo = makeRepo([]);
            service = new PoolModeHashrateService(repo as any, makeCacheManager(mockRedis) as any);
            await service.onModuleInit();
        });

        it('hIncrByFloats the mode field of pool:mode-hashrate:{slot}', async () => {
            const expectedSlot = TimeSlotHelper.getCurrentSlot();
            await service.incrementAccepted('pplns', 500);

            expect(mockRedis.hIncrByFloat).toHaveBeenCalledTimes(1);
            expect(mockRedis.hIncrByFloat).toHaveBeenCalledWith(
                `pool:mode-hashrate:${expectedSlot}`,
                'pplns',
                500,
            );
        });

        it('refreshes the slot key TTL alongside the increment', async () => {
            await service.incrementAccepted('solo', 100);

            expect(mockRedis.expire).toHaveBeenCalledTimes(1);
            expect(mockRedis.expire).toHaveBeenCalledWith(
                expect.stringMatching(/^pool:mode-hashrate:\d+$/),
                expect.any(Number),
            );
        });

        it('does not hit the repository — no per-share PG write', async () => {
            const repoSpy = makeRepo([]);
            const incrementSpy = jest.fn();
            const insertSpy = jest.fn();
            (repoSpy as any).increment = incrementSpy;
            (repoSpy as any).insert = insertSpy;
            const local = new PoolModeHashrateService(repoSpy as any, makeCacheManager(mockRedis) as any);
            await local.onModuleInit();

            await local.incrementAccepted('group-solo', 250);

            expect(incrementSpy).not.toHaveBeenCalled();
            expect(insertSpy).not.toHaveBeenCalled();
        });

        it('uses one slot key per timeslot, three hash fields per mode', async () => {
            await service.incrementAccepted('solo', 1);
            await service.incrementAccepted('pplns', 1);
            await service.incrementAccepted('group-solo', 1);

            const keys = new Set(mockRedis.hIncrByFloat.mock.calls.map((c: any[]) => c[0]));
            expect(keys.size).toBe(1);  // single key for the slot
            const fields = mockRedis.hIncrByFloat.mock.calls.map((c: any[]) => c[1]);
            expect(new Set(fields)).toEqual(new Set(['solo', 'pplns', 'group-solo']));
        });

        it('ignores non-positive or non-finite difficulties', async () => {
            await service.incrementAccepted('pplns', 0);
            await service.incrementAccepted('pplns', -5);
            await service.incrementAccepted('pplns', NaN);
            await service.incrementAccepted('pplns', Infinity);

            expect(mockRedis.hIncrByFloat).not.toHaveBeenCalled();
        });

        it('discards out-of-range share values to protect the `real` PG column', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            try {
                // Same incident class as PoolShareStatistics: a buggy SV2
                // client opens a channel with absurdly small maxTarget,
                // gets assigned diff in the e+50 range. PG `real` (~3.4e38)
                // refuses such a value on coordinator flush. Discard at
                // write time so the slot key stays clean.
                await service.incrementAccepted('pplns', 9.8e53);
                expect(mockRedis.hIncrByFloat).not.toHaveBeenCalled();
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('still accepts large but plausible values below MAX_REASONABLE_DIFFICULTY', async () => {
            // ~3.5e14 is real network difficulty in 2026; ceiling is 1e15.
            await service.incrementAccepted('pplns', 1e14);
            expect(mockRedis.hIncrByFloat).toHaveBeenCalledTimes(1);
        });

        it('exactly at the ceiling: discards', async () => {
            // Strict-greater-than guard, so MAX is allowed.
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            try {
                await service.incrementAccepted('pplns', MAX_REASONABLE_DIFFICULTY * 1.01);
                expect(mockRedis.hIncrByFloat).not.toHaveBeenCalled();
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('swallows Redis errors — share submit must never fail on stats write', async () => {
            mockRedis.hIncrByFloat.mockRejectedValueOnce(new Error('redis down'));
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            try {
                await expect(service.incrementAccepted('pplns', 100)).resolves.toBeUndefined();
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('no-ops when redis client is unavailable (no throw, no fall-through to PG)', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            try {
                const repo = makeRepo([]);
                const noRedis = new PoolModeHashrateService(repo as any, { store: {} } as any);
                await noRedis.onModuleInit();

                await noRedis.incrementAccepted('pplns', 100);
                // Nothing crashes; nothing written.
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('getChart (read path unchanged)', () => {
        it('uses TimeSlotHelper.getCurrentSlot() and excludes the current incomplete slot', async () => {
            const repo = makeRepo([]);
            const mockRedis = { hIncrByFloat: jest.fn(), expire: jest.fn() };
            const service = new PoolModeHashrateService(repo as any, makeCacheManager(mockRedis) as any);

            let captured: any;
            const origCreateQb = repo.createQueryBuilder;
            (repo as any).createQueryBuilder = (alias: string) => {
                const qb = origCreateQb(alias);
                const origGetRawMany = qb.getRawMany;
                qb.getRawMany = async () => {
                    const rows = await origGetRawMany();
                    captured = qb._captured;
                    return rows;
                };
                return qb;
            };

            await service.getChart('pplns', '1d');

            expect(captured.mode).toBe('pplns');
            // currentSlot MUST come from TimeSlotHelper (end-time). If a
            // future refactor inlines Math.floor(now/BUCKET)*BUCKET here,
            // this assertion breaks — which is the regression we want.
            expect(captured.currentSlot).toBe(TimeSlotHelper.getCurrentSlot());
            expect(captured.since).toBeLessThan(captured.currentSlot);
        });

        it('passes through SQL-aggregated data column unchanged', async () => {
            const repo = makeRepo([{ label: '1700000000000', data: '5000000000' }]);
            const mockRedis = { hIncrByFloat: jest.fn(), expire: jest.fn() };
            const service = new PoolModeHashrateService(repo as any, makeCacheManager(mockRedis) as any);

            const chart = await service.getChart('pplns', '1d');

            expect(chart).toEqual([{ label: '2023-11-14T22:13:20.000Z', data: 5000000000 }]);
        });

        it('scales range → diffDays: 1d ≈ 24h, 3d ≈ 72h, 7d ≈ 168h back from now', async () => {
            const expectations: Array<['1d' | '3d' | '7d', number]> = [
                ['1d', 1], ['3d', 3], ['7d', 7],
            ];
            for (const [range, days] of expectations) {
                const repo = makeRepo([]);
                const mockRedis = { hIncrByFloat: jest.fn(), expire: jest.fn() };
                const service = new PoolModeHashrateService(repo as any, makeCacheManager(mockRedis) as any);

                let captured: any;
                const origCreateQb = repo.createQueryBuilder;
                (repo as any).createQueryBuilder = (alias: string) => {
                    const qb = origCreateQb(alias);
                    const orig = qb.getRawMany;
                    qb.getRawMany = async () => {
                        captured = qb._captured;
                        return orig();
                    };
                    return qb;
                };

                const nowBefore = Date.now();
                await service.getChart('pplns', range);
                const nowAfter = Date.now();

                const expectedMin = nowBefore - days * 24 * 60 * 60 * 1000;
                const expectedMax = nowAfter - days * 24 * 60 * 60 * 1000;
                expect(captured.since).toBeGreaterThanOrEqual(expectedMin);
                expect(captured.since).toBeLessThanOrEqual(expectedMax);
            }
        });
    });

    it('re-exports SLOT_DURATION_MS matching mining.constants', async () => {
        const reExported = await import('./pool-mode-hashrate.service');
        const constants = await import('../../constants/mining.constants');
        expect(reExported.SLOT_DURATION_MS).toBe(constants.SLOT_DURATION_MS);
    });

    it('DIFFICULTY_1 matches mining.constants (guards against accidental inline overrides)', () => {
        expect(DIFFICULTY_1).toBe(4294967296);
    });
});
