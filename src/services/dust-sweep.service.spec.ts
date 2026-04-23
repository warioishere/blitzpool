jest.mock('node-telegram-bot-api', () => jest.fn());

import { DustSweepService } from './dust-sweep.service';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';

/**
 * Pure mock repo that emulates a tiny subset of TypeORM's Repository
 * interface — enough for the sweep service's createQueryBuilder filter
 * and delete/save operations. Uses an in-memory array as the backing
 * store so we can inspect the final state after a sweep run.
 */
function makeRepo<T extends Record<string, any>>(rows: T[]) {
    const repo: any = {
        _rows: rows,
        manager: {
            transaction: async (cb: (em: any) => Promise<any>) => cb(repo._manager),
        },
        createQueryBuilder: () => makeQb(rows),
        save: async (row: any) => { rows.push({ ...row }); return row; },
        create: (partial: any) => ({ ...partial }),
        delete: async (where: any) => {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (Object.entries(where).every(([k, v]) => (rows[i] as any)[k] === v)) {
                    rows.splice(i, 1);
                }
            }
            return { affected: 0 } as any;
        },
    };
    return repo;
}

/**
 * Minimal query-builder mock: only supports the where clauses DustSweepService
 * actually uses. Falls over loudly on anything else — we want tests to fail
 * if the service gains new filters without updated test coverage.
 */
function makeQb<T extends Record<string, any>>(rows: T[]) {
    let predicate: (row: any) => boolean = () => true;
    const addClause = (clause: (row: any) => boolean) => {
        const prev = predicate;
        predicate = (r) => prev(r) && clause(r);
    };
    const qb: any = {
        where: (expr: string) => {
            if (expr === 'b."pendingSats" > 0') addClause(r => (r.pendingSats ?? 0) > 0);
            else throw new Error(`unmocked where: ${expr}`);
            return qb;
        },
        andWhere: (expr: string, params?: any) => {
            if (expr === 'b."pendingSats" < :dust') {
                addClause(r => r.pendingSats < params.dust);
            } else if (expr === 'b."lastAcceptedShareAt" IS NOT NULL') {
                addClause(r => r.lastAcceptedShareAt != null);
            } else if (expr === 'b."lastAcceptedShareAt" < :cutoff') {
                const cutoff = params.cutoff.getTime();
                addClause(r => r.lastAcceptedShareAt.getTime() < cutoff);
            } else {
                throw new Error(`unmocked andWhere: ${expr}`);
            }
            return qb;
        },
        getMany: async () => rows.filter(predicate),
    };
    return qb;
}

function createService(opts: {
    pplnsBalance?: any[];
    pplnsHistory?: any[];
    groupBalance?: any[];
    groupHistory?: any[];
    dormantDays?: number;
    enabled?: boolean;
}) {
    const pplnsBalance = opts.pplnsBalance ?? [];
    const pplnsHistory = opts.pplnsHistory ?? [];
    const groupBalance = opts.groupBalance ?? [];
    const groupHistory = opts.groupHistory ?? [];

    const pplnsBalanceRepo = makeRepo(pplnsBalance);
    const pplnsHistoryRepo = makeRepo(pplnsHistory);
    const groupBalanceRepo = makeRepo(groupBalance);
    const groupHistoryRepo = makeRepo(groupHistory);

    // Tie them together so manager.transaction can dispatch via
    // em.getRepository(Entity). In the service each repo's own manager
    // is used (pplnsHistoryRepo for PPLNS, groupHistoryRepo for group),
    // so hook getRepository into each.
    const pplnsEm = {
        getRepository: (cls: any) => {
            if (cls === PplnsBalanceEntity) return pplnsBalanceRepo;
            if (cls === PplnsPayoutHistoryEntity) return pplnsHistoryRepo;
            throw new Error(`pplns em.getRepository: unmapped ${cls?.name}`);
        },
    };
    const groupEm = {
        getRepository: (cls: any) => {
            if (cls === PplnsGroupBalanceEntity) return groupBalanceRepo;
            if (cls === PplnsGroupBlockHistoryEntity) return groupHistoryRepo;
            throw new Error(`group em.getRepository: unmapped ${cls?.name}`);
        },
    };
    pplnsHistoryRepo.manager.transaction = async (cb: any) => cb(pplnsEm);
    groupHistoryRepo.manager.transaction = async (cb: any) => cb(groupEm);

    const configService = {
        get: (key: string) => {
            if (key === 'DUST_SWEEP_ENABLED') return opts.enabled === false ? 'false' : 'true';
            if (key === 'DUST_SWEEP_DORMANT_DAYS') return String(opts.dormantDays ?? 30);
            return undefined;
        },
    };

    const service = new DustSweepService(
        configService as any,
        pplnsBalanceRepo as any,
        pplnsHistoryRepo as any,
        groupBalanceRepo as any,
        groupHistoryRepo as any,
    );
    service.onModuleInit();
    return { service, pplnsBalance, pplnsHistory, groupBalance, groupHistory };
}

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe('DustSweepService', () => {

    describe('PPLNS sweep', () => {
        it('sweeps dust rows that are dormant past the threshold', async () => {
            const { service, pplnsBalance, pplnsHistory } = createService({
                pplnsBalance: [
                    // old dust — should be swept
                    { address: 'bc1qcold', pendingSats: 200, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(45) },
                    // active dust — should NOT be swept
                    { address: 'bc1qwarm', pendingSats: 100, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(5) },
                    // old but above dust — should NOT be swept (will eventually reach coinbase)
                    { address: 'bc1qrich', pendingSats: 5000, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(90) },
                    // old dust but no timestamp — should NOT be swept (pre-migration row)
                    { address: 'bc1qunknown', pendingSats: 50, totalPaidSats: 0, lastAcceptedShareAt: null },
                ],
                dormantDays: 30,
            });

            const result = await service.sweep();

            expect(result.pplnsSwept).toBe(1);
            expect(pplnsBalance.map((r: any) => r.address)).toEqual(
                expect.arrayContaining(['bc1qwarm', 'bc1qrich', 'bc1qunknown']),
            );
            expect(pplnsBalance.some((r: any) => r.address === 'bc1qcold')).toBe(false);
            // Audit row written
            expect(pplnsHistory).toHaveLength(1);
            expect(pplnsHistory[0]).toMatchObject({
                address: 'bc1qcold',
                paidSats: 200,
                percent: 0,
                inCoinbase: false,
                rowType: 'dust-sweep',
                blockHeight: 0,
            });
        });

        it('is a no-op when no rows match', async () => {
            const { service, pplnsHistory } = createService({
                pplnsBalance: [
                    { address: 'bc1qok', pendingSats: 1000, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(90) },
                ],
                dormantDays: 30,
            });
            const result = await service.sweep();
            expect(result.pplnsSwept).toBe(0);
            expect(pplnsHistory).toHaveLength(0);
        });

        it('respects configurable DUST_SWEEP_DORMANT_DAYS', async () => {
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qa', pendingSats: 50, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(5) },
                ],
                dormantDays: 3, // aggressive sweep
            });
            await service.sweep();
            expect(pplnsBalance).toHaveLength(0);
        });
    });

    describe('Group-Solo sweep', () => {
        it('sweeps dormant dust respecting (address, groupId) identity', async () => {
            const { service, groupBalance, groupHistory } = createService({
                groupBalance: [
                    { address: 'bc1qa', groupId: 'g1', pendingSats: 100, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(50) },
                    { address: 'bc1qa', groupId: 'g2', pendingSats: 100, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(5) },
                ],
                dormantDays: 30,
            });

            const result = await service.sweep();

            expect(result.groupSwept).toBe(1);
            expect(groupBalance).toHaveLength(1);
            expect(groupBalance[0]).toMatchObject({ groupId: 'g2' });
            expect(groupHistory[0]).toMatchObject({
                groupId: 'g1',
                address: 'bc1qa',
                paidSats: 100,
                rowType: 'dust-sweep',
                inCoinbase: false,
            });
        });
    });

    describe('disabled', () => {
        it('does nothing when DUST_SWEEP_ENABLED=false (scheduled path)', async () => {
            // sweepDaily() honors the flag; sweep() itself does not (for manual/admin trigger).
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qa', pendingSats: 50, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(99) },
                ],
                enabled: false,
                dormantDays: 30,
            });
            await service.sweepDaily();
            expect(pplnsBalance).toHaveLength(1);
        });
    });
});
