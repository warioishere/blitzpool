jest.mock('node-telegram-bot-api', () => jest.fn());

import { PoolModeHashrateService } from './pool-mode-hashrate.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';
import { MAX_REASONABLE_DIFFICULTY } from '../../constants/mining.constants';

/**
 * Invariants:
 *
 *   1. Writes accumulate in process memory — no per-share PG hit, no Redis.
 *      Earlier history: direct-PG-per-share caused row-lock contention; the
 *      Redis-buffered version solved that but generated ~36% of pool-wide
 *      Redis CPU. In-memory drain/confirm has neither problem.
 *
 *   2. The chart read MUST use `TimeSlotHelper.getChartVisibilityCutoffSlot()`
 *      so the just-ended slot stays hidden until the coordinator flush has
 *      had a chance to commit it. Reinventing this filter is what caused the
 *      original "PPLNS curve doesn't match total" 10-min divergence.
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

describe('PoolModeHashrateService', () => {

    describe('incrementAccepted (in-memory accumulator)', () => {
        let service: PoolModeHashrateService;

        beforeEach(() => {
            const repo = makeRepo([]);
            service = new PoolModeHashrateService(repo as any);
        });

        it('records the diff under the current slot for the given mode', () => {
            const expectedSlot = TimeSlotHelper.getCurrentSlot();
            service.incrementAccepted('pplns', 500);

            const drained = service.drainSlotDeltas();
            expect(drained.get(expectedSlot)?.get('pplns')).toBe(500);
        });

        it('keeps three independent mode totals under one slot', () => {
            service.incrementAccepted('solo', 1);
            service.incrementAccepted('pplns', 2);
            service.incrementAccepted('group-solo', 3);
            service.incrementAccepted('solo', 4);

            const drained = service.drainSlotDeltas();
            expect(drained.size).toBe(1);
            const slot = drained.keys().next().value;
            const modes = drained.get(slot)!;
            expect(modes.get('solo')).toBe(5);
            expect(modes.get('pplns')).toBe(2);
            expect(modes.get('group-solo')).toBe(3);
        });

        it('does NOT call the repository — share submit is in-memory only', () => {
            const repoSpy = makeRepo([]);
            const incrementSpy = jest.fn();
            const insertSpy = jest.fn();
            (repoSpy as any).increment = incrementSpy;
            (repoSpy as any).insert = insertSpy;
            const local = new PoolModeHashrateService(repoSpy as any);

            local.incrementAccepted('group-solo', 250);

            expect(incrementSpy).not.toHaveBeenCalled();
            expect(insertSpy).not.toHaveBeenCalled();
        });

        it('ignores non-positive or non-finite difficulties', () => {
            service.incrementAccepted('pplns', 0);
            service.incrementAccepted('pplns', -5);
            service.incrementAccepted('pplns', NaN);
            service.incrementAccepted('pplns', Infinity);

            expect(service.drainSlotDeltas().size).toBe(0);
        });

        it('discards out-of-range share values to protect the `real` PG column', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            try {
                // Same incident class as PoolShareStatistics: a buggy SV2
                // client opens a channel with absurdly small maxTarget,
                // gets assigned diff in the e+50 range. PG `real` (~3.4e38)
                // refuses such a value on coordinator flush. Discard at
                // write time so the slot key stays clean.
                service.incrementAccepted('pplns', 9.8e53);
                expect(service.drainSlotDeltas().size).toBe(0);
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('still accepts large but plausible values below MAX_REASONABLE_DIFFICULTY', () => {
            // ~3.5e14 is real network difficulty in 2026; ceiling is 1e15.
            service.incrementAccepted('pplns', 1e14);
            const drained = service.drainSlotDeltas();
            expect(drained.size).toBe(1);
        });

        it('above the ceiling: discards', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            try {
                service.incrementAccepted('pplns', MAX_REASONABLE_DIFFICULTY * 1.01);
                expect(service.drainSlotDeltas().size).toBe(0);
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('drain / confirm', () => {
        let service: PoolModeHashrateService;
        beforeEach(() => { service = new PoolModeHashrateService(makeRepo([]) as any); });

        it('drainSlotDeltas does NOT clear the cache — confirm is required', () => {
            service.incrementAccepted('pplns', 100);
            const first = service.drainSlotDeltas();
            const second = service.drainSlotDeltas();
            expect(first.size).toBe(1);
            expect(second.size).toBe(1);
        });

        it('confirmFlush subtracts only the flushed amounts; residuals stay', () => {
            const slot = TimeSlotHelper.getCurrentSlot();
            service.incrementAccepted('pplns', 100);
            const snapshot = service.drainSlotDeltas();

            // A share arrives during the simulated PG await:
            service.incrementAccepted('pplns', 30);

            service.confirmFlush(snapshot);

            const after = service.drainSlotDeltas();
            expect(after.get(slot)?.get('pplns')).toBe(30);
        });

        it('confirmFlush removes the slot entry entirely when nothing remains', () => {
            service.incrementAccepted('pplns', 50);
            const snapshot = service.drainSlotDeltas();
            service.confirmFlush(snapshot);
            expect(service.drainSlotDeltas().size).toBe(0);
        });
    });

    describe('getChart (read path)', () => {
        it('uses TimeSlotHelper.getChartVisibilityCutoffSlot() so just-ended slots stay hidden until flushed', async () => {
            const repo = makeRepo([]);
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
            // currentSlot MUST come from TimeSlotHelper.getChartVisibilityCutoffSlot()
            // (which subtracts the visibility buffer from now before computing
            // the slot). If a future refactor reverts to getCurrentSlot() the
            // chart starts showing not-yet-fully-flushed slots — this
            // assertion is the canary.
            expect(captured.currentSlot).toBe(TimeSlotHelper.getChartVisibilityCutoffSlot());
            expect(captured.since).toBeLessThan(captured.currentSlot);
        });

        it('passes through SQL-aggregated data column unchanged', async () => {
            const repo = makeRepo([{ label: '1700000000000', data: '5000000000' }]);
            const service = new PoolModeHashrateService(repo as any);

            const chart = await service.getChart('pplns', '1d');

            expect(chart).toEqual([{ label: '2023-11-14T22:13:20.000Z', data: 5000000000 }]);
        });

        it('scales range → diffDays: 1d ≈ 24h, 3d ≈ 72h, 7d ≈ 168h back from now', async () => {
            const expectations: Array<['1d' | '3d' | '7d', number]> = [
                ['1d', 1], ['3d', 3], ['7d', 7],
            ];
            for (const [range, days] of expectations) {
                const repo = makeRepo([]);
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

                const expectedMin = nowBefore - days * 24 * 60 * 60 * 1000;
                const expectedMax = nowAfter - days * 24 * 60 * 60 * 1000;
                expect(captured.since).toBeGreaterThanOrEqual(expectedMin);
                expect(captured.since).toBeLessThanOrEqual(expectedMax);
            }
        });
    });
});
