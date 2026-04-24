jest.mock('node-telegram-bot-api', () => jest.fn());

import { DustSweepService } from './dust-sweep.service';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';

/**
 * Pure mock repo that emulates a tiny subset of TypeORM's Repository
 * interface — enough for the sweep service's createQueryBuilder filter
 * and delete/save/update operations. Uses an in-memory array as the
 * backing store so we can inspect the final state after a sweep run.
 */
function makeRepo<T extends Record<string, any>>(rows: T[]) {
    const repo: any = {
        _rows: rows,
        manager: {
            transaction: async (cb: (em: any) => Promise<any>) => cb(repo._manager),
        },
        createQueryBuilder: () => makeQb(rows),
        save: async (rowOrRows: any) => {
            if (Array.isArray(rowOrRows)) {
                for (const r of rowOrRows) rows.push({ ...r });
                return rowOrRows;
            }
            rows.push({ ...rowOrRows });
            return rowOrRows;
        },
        create: (partial: any) => ({ ...partial }),
        delete: async (where: any) => {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (Object.entries(where).every(([k, v]) => (rows[i] as any)[k] === v)) {
                    rows.splice(i, 1);
                }
            }
            return { affected: 0 } as any;
        },
        update: async (where: any, patch: any) => {
            for (const r of rows) {
                if (Object.entries(where).every(([k, v]) => (r as any)[k] === v)) {
                    Object.assign(r, patch);
                }
            }
            return { affected: 0 } as any;
        },
    };
    return repo;
}

/**
 * Minimal query-builder mock: only supports the where clauses
 * DustSweepService actually uses. Falls over loudly on anything else —
 * we want tests to fail if the service gains new filters without
 * updated test coverage.
 */
function makeQb<T extends Record<string, any>>(rows: T[]) {
    let predicate: (row: any) => boolean = () => true;
    const addClause = (clause: (row: any) => boolean) => {
        const prev = predicate;
        predicate = (r) => prev(r) && clause(r);
    };
    const qb: any = {
        where: (expr: string) => {
            if (expr === 'b."pendingSats" > 0') {
                addClause(r => (r.pendingSats ?? 0) > 0);
            } else if (expr === 'b."balanceSats" != 0') {
                addClause(r => (r.balanceSats ?? 0) !== 0);
            } else {
                throw new Error(`unmocked where: ${expr}`);
            }
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
        getMany: async () => rows.filter(predicate).map(r => ({ ...r })),   // snapshot copy
    };
    return qb;
}

function createService(opts: {
    pplnsBalance?: any[];
    pplnsHistory?: any[];
    groupBalance?: any[];
    groupHistory?: any[];
    dormantDays?: number;
    abandonedDays?: number;
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
            if (key === 'ABANDONED_BALANCE_DAYS') return String(opts.abandonedDays ?? 180);
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

    describe('PPLNS pair-sweep (signed ledger)', () => {
        it('pairs largest abandoned credit with largest abandoned debit', async () => {
            // Both abandoned > 6 months. Credit +500 pairs with debit -500.
            const { service, pplnsBalance, pplnsHistory } = createService({
                pplnsBalance: [
                    { address: 'bc1qcred', balanceSats: 500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                    { address: 'bc1qdebt', balanceSats: -500, totalPaidSats: 1_000_000, lastAcceptedShareAt: daysAgo(200) },
                ],
                abandonedDays: 180,
            });

            const result = await service.sweep();

            expect(result.pplnsPaired).toBe(2);
            expect(result.pplnsSatsPaired).toBe(500);
            // Both rows removed after full cancellation.
            expect(pplnsBalance).toHaveLength(0);
            // Two audit rows, one per side.
            expect(pplnsHistory).toHaveLength(2);
            const creditAudit = pplnsHistory.find((r: any) => r.address === 'bc1qcred');
            const debitAudit = pplnsHistory.find((r: any) => r.address === 'bc1qdebt');
            expect(creditAudit).toMatchObject({ paidSats: 500, rowType: 'dust-sweep', inCoinbase: false });
            expect(debitAudit).toMatchObject({ paidSats: 500, rowType: 'dust-sweep', inCoinbase: false });
            // Same blockHeight marker so an operator can trace the pair.
            expect(creditAudit.blockHeight).toBe(debitAudit.blockHeight);
            expect(creditAudit.blockHeight).toBeLessThan(0);
        });

        it('partial pair leaves the larger side with its residual balance', async () => {
            // Credit +800 vs debit -500 → 500 cancelled, credit shrinks to +300.
            const { service, pplnsBalance, pplnsHistory } = createService({
                pplnsBalance: [
                    { address: 'bc1qcred', balanceSats: 800, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                    { address: 'bc1qdebt', balanceSats: -500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                ],
                abandonedDays: 180,
            });

            const result = await service.sweep();

            expect(result.pplnsPaired).toBe(2);
            expect(result.pplnsSatsPaired).toBe(500);
            // Credit row stays with residual +300.
            expect(pplnsBalance).toHaveLength(1);
            expect(pplnsBalance[0]).toMatchObject({ address: 'bc1qcred', balanceSats: 300 });
            // Debit row fully removed.
            expect(pplnsHistory).toHaveLength(2);
        });

        it('abandoned credit with no abandoned counterparty stays in ledger', async () => {
            // Debtor is still active (recent timestamp) → no pairing.
            const { service, pplnsBalance, pplnsHistory } = createService({
                pplnsBalance: [
                    { address: 'bc1qcred', balanceSats: 500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                    { address: 'bc1qdebt', balanceSats: -500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(5) },
                ],
                abandonedDays: 180,
            });

            const result = await service.sweep();

            expect(result.pplnsPaired).toBe(0);
            expect(result.pplnsSatsPaired).toBe(0);
            // Everything intact — wait for active debtor to return or abandon.
            expect(pplnsBalance).toHaveLength(2);
            expect(pplnsHistory).toHaveLength(0);
        });

        it('only credits abandoned (no debits) → no-op, credits left in ledger', async () => {
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qa', balanceSats: 200, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                    { address: 'bc1qb', balanceSats: 150, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                ],
                abandonedDays: 180,
            });

            const result = await service.sweep();

            expect(result.pplnsPaired).toBe(0);
            expect(pplnsBalance).toHaveLength(2);
        });

        it('pool-neutrality: sum(balances) unchanged by pair-cancellation', async () => {
            // Multiple pairs + residual tail. Verify net sum stays identical.
            const balances = [
                { address: 'bc1qa', balanceSats: 1000, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                { address: 'bc1qb', balanceSats: 400, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                { address: 'bc1qc', balanceSats: 100, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                { address: 'bc1qd', balanceSats: -700, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                { address: 'bc1qe', balanceSats: -300, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
            ];
            const beforeSum = balances.reduce((s, r) => s + r.balanceSats, 0);
            expect(beforeSum).toBe(500);    // 1500 credits - 1000 debits

            const { service, pplnsBalance } = createService({
                pplnsBalance: balances,
                abandonedDays: 180,
            });

            await service.sweep();

            const afterSum = pplnsBalance.reduce((s, r) => s + r.balanceSats, 0);
            // Net sum preserved — only matched pairs cancelled.
            expect(afterSum).toBe(500);
        });

        it('respects configurable ABANDONED_BALANCE_DAYS', async () => {
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qcred', balanceSats: 500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(10) },
                    { address: 'bc1qdebt', balanceSats: -500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(10) },
                ],
                abandonedDays: 7,     // aggressive
            });

            await service.sweep();

            expect(pplnsBalance).toHaveLength(0);   // both paired
        });

        it('does not sweep rows with NULL lastAcceptedShareAt (pre-migration)', async () => {
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qold', balanceSats: 500, totalPaidSats: 0, lastAcceptedShareAt: null },
                    { address: 'bc1qdebt', balanceSats: -500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(200) },
                ],
                abandonedDays: 180,
            });

            const result = await service.sweep();

            // Credit has no timestamp → not an abandonment candidate; no pairing.
            expect(result.pplnsPaired).toBe(0);
            expect(pplnsBalance).toHaveLength(2);
        });
    });

    describe('Group-Solo dust sweep (legacy unsigned path)', () => {
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

        it('group-solo dust sweep ignores above-dust balances and active rows', async () => {
            const { service, groupBalance } = createService({
                groupBalance: [
                    // old dust — swept
                    { address: 'bc1qcold', groupId: 'g1', pendingSats: 100, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(40) },
                    // active dust — kept
                    { address: 'bc1qwarm', groupId: 'g1', pendingSats: 50, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(5) },
                    // above dust — kept
                    { address: 'bc1qrich', groupId: 'g1', pendingSats: 50_000, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(90) },
                ],
                dormantDays: 30,
            });

            await service.sweep();
            expect(groupBalance.map((r: any) => r.address).sort()).toEqual(['bc1qrich', 'bc1qwarm']);
        });
    });

    describe('disabled', () => {
        it('does nothing when DUST_SWEEP_ENABLED=false (scheduled path)', async () => {
            const { service, pplnsBalance } = createService({
                pplnsBalance: [
                    { address: 'bc1qa', balanceSats: 500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(300) },
                    { address: 'bc1qb', balanceSats: -500, totalPaidSats: 0, lastAcceptedShareAt: daysAgo(300) },
                ],
                enabled: false,
            });
            await service.sweepDaily();
            expect(pplnsBalance).toHaveLength(2);
        });
    });
});
