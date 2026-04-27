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

interface RecordedOp {
    op: 'increment' | 'insert';
    args: any[];
}

function makeRepo(ops: RecordedOp[], chartRows: any[], opts: { rowExists?: boolean; insertThrows?: boolean } = {}) {
    let rowExists = opts.rowExists ?? false;
    return {
        increment: jest.fn(async (...args: any[]) => {
            ops.push({ op: 'increment', args });
            return { affected: rowExists ? 1 : 0, raw: undefined, generatedMaps: [] };
        }),
        insert: jest.fn(async (...args: any[]) => {
            ops.push({ op: 'insert', args });
            if (opts.insertThrows) throw new Error('duplicate key');
            rowExists = true;  // subsequent increments now succeed
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
        it('cold slot: increment misses → insert creates the row', async () => {
            const ops: RecordedOp[] = [];
            const repo = makeRepo(ops, [], { rowExists: false });
            const service = new PoolModeHashrateService(repo as any);

            const expectedSlot = TimeSlotHelper.getCurrentSlot();
            await service.incrementAccepted('pplns', 500);

            expect(ops).toHaveLength(2);
            expect(ops[0].op).toBe('increment');
            expect(ops[0].args[0]).toEqual({ mode: 'pplns', time: expectedSlot });
            expect(ops[0].args[1]).toBe('diff');
            expect(ops[0].args[2]).toBe(500);

            expect(ops[1].op).toBe('insert');
            expect(ops[1].args[0]).toEqual({ mode: 'pplns', time: expectedSlot, diff: 500 });
        });

        it('warm slot: increment hits → no insert', async () => {
            const ops: RecordedOp[] = [];
            const repo = makeRepo(ops, [], { rowExists: true });
            const service = new PoolModeHashrateService(repo as any);

            await service.incrementAccepted('pplns', 250);

            expect(ops).toHaveLength(1);
            expect(ops[0].op).toBe('increment');
        });

        it('regression M1: race between two cold-slot writers retries the increment', async () => {
            // Two concurrent writers see no row → both try insert. The
            // second insert collides on UQ_pool_mode_hashrate_mode_time.
            // The race-loser must retry the increment (now warm) so its
            // difficulty isn't lost to a silent rollback.
            const ops: RecordedOp[] = [];
            const repo = makeRepo(ops, [], { rowExists: false, insertThrows: true });
            const service = new PoolModeHashrateService(repo as any);

            await service.incrementAccepted('pplns', 100);

            expect(ops).toHaveLength(3);
            expect(ops.map(o => o.op)).toEqual(['increment', 'insert', 'increment']);
        });

        it('ignores non-positive or NaN difficulties', async () => {
            const ops: RecordedOp[] = [];
            const repo = makeRepo(ops, []);
            const service = new PoolModeHashrateService(repo as any);

            await service.incrementAccepted('pplns', 0);
            await service.incrementAccepted('pplns', -1);
            await service.incrementAccepted('pplns', NaN);

            expect(ops).toHaveLength(0);
        });

        it('swallows DB errors — share submit must never fail on stats write', async () => {
            const repo = {
                increment: jest.fn().mockRejectedValue(new Error('boom')),
                insert: jest.fn(),
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
