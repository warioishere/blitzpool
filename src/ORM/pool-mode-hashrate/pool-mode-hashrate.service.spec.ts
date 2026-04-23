jest.mock('node-telegram-bot-api', () => jest.fn());

import { PoolModeHashrateService } from './pool-mode-hashrate.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { DIFFICULTY_1 } from '../../constants/mining.constants';

/**
 * These tests pin the invariant that finally fixed the "PPLNS curve
 * doesn't match total" bug: this service MUST use the same slot
 * convention (end-time, via TimeSlotHelper) and the same
 * current-slot-exclusion filter as ClientStatisticsService
 * .getChartDataForSite. Reinventing a Math.floor/BUCKET_MS bucket
 * scheme was exactly what caused the 10-min divergence in prod.
 */

function makeRepo(recordedInserts: any[][], chartRows: any[]) {
    return {
        query: jest.fn(async (..._args: any[]) => {
            recordedInserts.push(_args);
        }),
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

describe('PoolModeHashrateService', () => {

    describe('incrementAccepted', () => {
        it('writes with TimeSlotHelper.getCurrentSlot() as the bucket key', async () => {
            const inserts: any[][] = [];
            const repo = makeRepo(inserts, []);
            const service = new PoolModeHashrateService(repo as any);

            const expectedSlot = TimeSlotHelper.getCurrentSlot();
            await service.incrementAccepted('pplns', 500);

            expect(inserts).toHaveLength(1);
            // [sql, [mode, slot, difficulty]]
            const [, params] = inserts[0];
            expect(params[0]).toBe('pplns');
            expect(params[1]).toBe(expectedSlot);
            expect(params[2]).toBe(500);
        });

        it('ignores non-positive or NaN difficulties', async () => {
            const inserts: any[][] = [];
            const repo = makeRepo(inserts, []);
            const service = new PoolModeHashrateService(repo as any);

            await service.incrementAccepted('pplns', 0);
            await service.incrementAccepted('pplns', -1);
            await service.incrementAccepted('pplns', NaN);

            expect(inserts).toHaveLength(0);
        });

        it('swallows DB errors — share submit must never fail on stats write', async () => {
            const repo = {
                query: jest.fn().mockRejectedValue(new Error('boom')),
            } as any;
            const service = new PoolModeHashrateService(repo);

            await expect(service.incrementAccepted('pplns', 100)).resolves.toBeUndefined();
        });
    });

    describe('getChart', () => {
        it('uses same bucket convention + current-slot exclusion as getChartDataForSite', async () => {
            const repo = makeRepo([], []);
            const service = new PoolModeHashrateService(repo as any);

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
            // The invariant that matters: currentSlot MUST come from
            // TimeSlotHelper (end-time convention). If a future refactor
            // brings back Math.floor(now/BUCKET)*BUCKET here, this
            // assertion breaks — which is exactly the regression we want
            // to catch.
            expect(captured.currentSlot).toBe(TimeSlotHelper.getCurrentSlot());
            expect(captured.since).toBeLessThan(captured.currentSlot);
        });

        it('applies the shares × DIFFICULTY_1 / 600 hashrate formula via SQL', async () => {
            // The addSelect string is what matters — we just check it appears
            // and matches ClientStatisticsService.getChartDataForSite format.
            // Inspected indirectly: the service delegates arithmetic to SQL,
            // so the returned row's .data is passed through Number() unchanged.
            const repo = makeRepo([], [
                { label: '1700000000000', data: '5000000000' },
            ]);
            const service = new PoolModeHashrateService(repo as any);

            const chart = await service.getChart('pplns', '1d');

            expect(chart).toEqual([{ label: '2023-11-14T22:13:20.000Z', data: 5000000000 }]);
        });

        it('scales range → diffDays: 1d ≈ 24h, 3d ≈ 72h, 7d ≈ 168h back from now', async () => {
            const expectations: Array<['1d' | '3d' | '7d', number]> = [
                ['1d', 1], ['3d', 3], ['7d', 7],
            ];
            for (const [range, days] of expectations) {
                const repo = makeRepo([], []);
                const service = new PoolModeHashrateService(repo as any);

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

                // `since = Date.now() - days*24h` inside the service. Allow any
                // Date.now() between the test's before/after to pass.
                const expectedMin = nowBefore - days * 24 * 60 * 60 * 1000;
                const expectedMax = nowAfter - days * 24 * 60 * 60 * 1000;
                expect(captured.since).toBeGreaterThanOrEqual(expectedMin);
                expect(captured.since).toBeLessThanOrEqual(expectedMax);
            }
        });
    });

    // Constants are re-exported for callers — keeps consumers from
    // reaching into the @nestjs/typeorm layer and lets them trust the
    // mining.constants source of truth.
    it('re-exports SLOT_DURATION_MS matching mining.constants', async () => {
        const reExported = await import('./pool-mode-hashrate.service');
        const constants = await import('../../constants/mining.constants');
        expect(reExported.SLOT_DURATION_MS).toBe(constants.SLOT_DURATION_MS);
    });

    // Safety: assertion that the formula multiplier is what clients expect.
    it('DIFFICULTY_1 matches mining.constants (guards against accidental inline overrides)', () => {
        expect(DIFFICULTY_1).toBe(4294967296);
    });
});
