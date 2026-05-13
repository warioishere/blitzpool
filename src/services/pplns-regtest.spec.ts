/**
 * PPLNS Regtest — verifies the PPLNS engine's coinbase distribution
 * survives a real Bitcoin Core block submit when miners have non-zero
 * pending balances carried from prior sub-dust rounds.
 *
 * Directly analogous to the group-solo kick-redistribute regtest: the
 * whole point is to exercise the pending-settled-out-of-miner-cut path
 * end-to-end against bitcoind's `bad-cb-amount` check. Before the shared
 * `buildCoinbaseDistribution` refactor this path would have failed the
 * submit — pending was added ON TOP of the miner cut.
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test,
 * rpcpassword=test).
 */

import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import {
    rpcCall,
    createMockRedis,
    assembleWithMiningJobAndTemplate,
} from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ALICE = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';
const ADDR_CHARLIE = 'bcrt1qlppw7cnqspnky6qzv8p2n468lpvwuct7ehp7l2';

// ── Balance backing: single row store exposed as both service and repo
// facades. onBlockFound reads via `this.balanceService.getAllWithBalance()`
// outside the TX, then mutates via `em.getRepository(PplnsBalanceEntity)`
// inside the TX — both must see the same state.
function createMockBalanceBacking() {
    const rows: any[] = [];
    const find = (addr: string) => rows.find((r: any) => r.address === addr);
    const service = {
        getAllWithBalance: async () => rows.filter((r: any) => r.balanceSats !== 0),
        getBalanceSats: async (addr: string) => find(addr)?.balanceSats ?? 0,
        addBalance: async (addr: string, sats: number) => {
            const existing = find(addr);
            if (existing) existing.balanceSats += sats;
            else rows.push({ address: addr, balanceSats: sats, totalPaidSats: 0 });
        },
        markPaid: async (addr: string, sats: number) => {
            const existing = find(addr);
            if (existing) {
                existing.balanceSats = Math.max(0, existing.balanceSats - sats);
                existing.totalPaidSats += sats;
            }
        },
        markTouch: (_addr: string) => undefined,
        flushPendingTouches: async () => undefined,
        _rows: rows,
    };
    const applySave = (row: any) => {
        const existing = find(row.address);
        if (existing) Object.assign(existing, row);
        else rows.push(row);
        return row;
    };
    const repo: any = {
        findOneBy: async (where: any) => find(where.address) ?? null,
        save: async (arg: any) =>
            Array.isArray(arg) ? arg.map(applySave) : applySave(arg),
        insert: async (arg: any) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        },
        create: (partial: any) => ({ ...partial }),
        find: async (q: any) => {
            const inOp = q?.where?.address;
            if (inOp && typeof inOp === 'object' && Array.isArray(inOp._value)) {
                const set = new Set<string>(inOp._value);
                return rows.filter((r: any) => set.has(r.address));
            }
            if (q?.where?.balanceSats) return rows.filter((r: any) => r.balanceSats !== 0);
            return [...rows];
        },
        _rows: rows,
    };
    return { service, repo, _rows: rows };
}

function createMockHistoryRepo() {
    const rows: any[] = [];
    // findOneBy lets the idempotency pre-check work: returns first matching row
    // (by blockHeight) if present.
    const repo: any = {
        save: async (arg: any) => {
            if (Array.isArray(arg)) { for (const r of arg) rows.push(r); return arg; }
            rows.push(arg); return arg;
        },
        insert: async (arg: any) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        },
        create: (partial: any) => ({ ...partial }),
        findOneBy: async (where: any) =>
            rows.find((r: any) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
        _rows: rows,
    };
    return repo;
}

function createMockJobsService() {
    return {
        newMiningJob$: {
            subscribe: () => ({ unsubscribe: () => undefined }),
        },
    };
}

function makeService(opts: { feeAddress?: string; feePercent?: string } = {}) {
    const env: Record<string, string> = {
        PPLNS_PORT: '3336',
        PPLNS_FEE_ADDRESS: opts.feeAddress ?? ADDR_FEE,
        PPLNS_FEE_PERCENT: opts.feePercent ?? '2',
    };
    const balanceBacking = createMockBalanceBacking();
    const historyRepo = createMockHistoryRepo();
    attachMockTxManager([
        [PplnsPayoutHistoryEntity, historyRepo],
        [PplnsBalanceEntity, balanceBacking.repo],
    ]);
    const service = new PplnsService(
        { get: (k: string) => env[k] } as any,
        { store: {} } as any,
        balanceBacking.service as any,
        historyRepo as any,
        createMockJobsService() as any,
    );
    const redis = createMockRedis();
    (service as any).redis = redis;
    (service as any).enabled = true;
    service.setNetworkDifficulty(1e12); // generous window, no trimming
    return { service, redis, balanceService: balanceBacking.service, historyRepo };
}


// ═══════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════

describe('PPLNS Regtest — pending-out-of-miner-cut invariant', () => {

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
            // Force single-wallet state — unscoped wallet RPCs are ambiguous
            // if a stale wallet from a prior session is still attached.
            const wallets: string[] = await rpcCall('listwallets');
            for (const name of wallets) {
                if (name !== 'default') {
                    try { await rpcCall('unloadwallet', [name]); } catch { /* ignore */ }
                }
            }
            if (!wallets.includes('default')) {
                try { await rpcCall('createwallet', ['default']); } catch { /* already */ }
            }
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch (e) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443 — ${(e as Error).message}`);
        }
    });

    it('active miners with non-zero pending → coinbase validates, total ≤ blockReward', async () => {
        const { service, balanceService, historyRepo } = makeService();

        // Seed pending from prior sub-dust rounds: Charlie accumulated
        // 50 000 sats over time without mining to the current window.
        (balanceService._rows as any[]).push(
            { address: ADDR_CHARLIE, balanceSats: 50_000, totalPaidSats: 0 },
        );
        // Alice also has small pending from earlier block's rounding.
        (balanceService._rows as any[]).push(
            { address: ADDR_ALICE, balanceSats: 1_500, totalPaidSats: 0 },
        );

        // Alice + Bob mine actively this round.
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        // Active miners (Alice + Bob) and the fee must appear — they're
        // the deterministic outputs.
        //
        // Pending-only miners (Charlie) are eligible for an on-chain
        // output IF their post-solvency-cap onChain is positive. With
        // a very tight credit configuration (sum-of-credits ≈ overshoot),
        // the cap may fully consume one credit-claimer's balance, in
        // which case their output drops out of THIS block's coinbase
        // but their carry-forward credit (balanceAfter) is preserved
        // for the next block. That's the documented Phase 5a.5
        // abandoned-debtor delay semantics, not a missed payout.
        const addrs = distribution.map(d => d.address);
        expect(addrs).toContain(ADDR_FEE);
        expect(addrs).toContain(ADDR_ALICE);
        expect(addrs).toContain(ADDR_BOB);

        // Percent sum must not exceed 100 (modulo float noise). This is
        // the exact invariant that the pre-refactor PPLNS violated —
        // pending was layered on top of the miner cut.
        const totalPct = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);

        // And Core must accept the block — through the production MiningJob path.
        const { submitResult } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-pending');
        expect(submitResult).toBeNull();

        await service.onBlockFound(template.height, template.coinbasevalue);
        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyForBlock.length).toBe(distribution.length);

        console.log('✅ PPLNS with pending: coinbase total respects blockReward, Core accepted');
    }, 120000);

    it('snapshot-persist: distribution snapshot survives service restart via Redis', async () => {
        // Mirrors the group-solo snapshot-persist test: write snapshot via
        // service A (simulates the moment miners receive the coinbase
        // template), then spin up service B on the same Redis and run
        // onBlockFound — B must book payouts from the persisted snapshot,
        // not fall back to onBlockFoundFromWindow.
        const env: Record<string, string> = {
            PPLNS_PORT: '3336',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
        };
        const balanceBacking = createMockBalanceBacking();
        const historyRepo = createMockHistoryRepo();
        attachMockTxManager([
            [PplnsPayoutHistoryEntity, historyRepo],
            [PplnsBalanceEntity, balanceBacking.repo],
        ]);

        const redis = createMockRedis();
        const svcA = new PplnsService(
            { get: (k: string) => env[k] } as any,
            { store: {} } as any,
            balanceBacking.service as any,
            historyRepo as any,
            createMockJobsService() as any,
        );
        (svcA as any).redis = redis;
        (svcA as any).enabled = true;
        svcA.setNetworkDifficulty(1e12);

        await svcA.recordShare(ADDR_ALICE, 100);
        await svcA.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;

        const distributionA = await svcA.getPayoutDistribution(blockReward);
        // Snapshot must be in Redis now.
        expect(redis._store.get('pplns:snapshot')).toBeTruthy();

        // Simulate pool restart: new service instance, same Redis.
        const svcB = new PplnsService(
            { get: (k: string) => env[k] } as any,
            { store: {} } as any,
            balanceBacking.service as any,
            historyRepo as any,
            createMockJobsService() as any,
        );
        (svcB as any).redis = redis;
        (svcB as any).enabled = true;
        svcB.setNetworkDifficulty(1e12);

        // Build + submit the block using A's distribution — production MiningJob path.
        const { submitResult } = await assembleWithMiningJobAndTemplate(distributionA, template, 'pplns-snapshot');
        expect(submitResult).toBeNull();

        // Book payouts via service B — must read the Redis snapshot, not fall through.
        await svcB.onBlockFound(template.height, blockReward);

        // History entries should reflect A's distribution — one per payout entry.
        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height,
        );
        expect(historyForBlock.length).toBe(distributionA.length);
        expect(historyForBlock.map(r => r.address).sort())
            .toEqual(distributionA.map(d => d.address).sort());

        // Snapshot key consumed.
        expect(redis._store.get('pplns:snapshot')).toBeUndefined();

        console.log('✅ PPLNS snapshot-persist: fresh service instance consumed Redis snapshot');
    }, 120000);

    it('tiny feePercent → fee output dust-gated, block still validates', async () => {
        // 0.00001 % of 5 BTC subsidy = 500 sats < 546 dust.
        const { service, historyRepo } = makeService({ feePercent: '0.00001' });
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 100);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_FEE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB].sort());

        const { submitResult } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-dust');
        expect(submitResult).toBeNull();

        await service.onBlockFound(template.height, template.coinbasevalue);
        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyForBlock.length).toBe(distribution.length);

        console.log('✅ PPLNS dust-fee-gate: fee omitted, miners keep 100 %, block accepted');
    }, 120000);
});
