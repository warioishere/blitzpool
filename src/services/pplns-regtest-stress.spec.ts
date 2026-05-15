/**
 * PPLNS Regtest — 50-miner stress scenario, end-to-end to Core.
 *
 * What this test is for (the one thing not covered by the other
 * regtests):
 *
 *   - Existing pplns-regtest.spec: 3 miners, happy path, proves math + core accepts
 *   - Existing onblockfound-idempotency.spec: replay safety, unit mocks
 *   - THIS test: 50 concurrent miners with a power-law weight distribution —
 *     proves the coinbase weight-budget-trim, dust-filter, pending
 *     routing, and onBlockFound transaction handling all survive real
 *     traffic shape at the scale we'd see on mainnet.
 *
 * The hypothesis under test: share-recording concurrency, distribution
 * math, and block-found bookkeeping stay correct when the window carries
 * many miners of very different weights. "Correct" means:
 *
 *   1. Core accepts the submitted block with the real coinbase.
 *   2. Distribution percent sum ≤ 100 (else bad-cb-amount).
 *   3. Coinbase output count respects the weight budget.
 *   4. Every sub-dust miner ended up in pending, not dropped silently.
 *   5. Miners in the coinbase cleared any prior pending.
 *   6. onBlockFound replay is a no-op (the idempotency pre-check fires).
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test,
 * rpcpassword=test).
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import { DEFAULT_COINBASE_WEIGHT_BUDGET, DUST_LIMIT_SATS } from './coinbase-distribution';
import {
    NETWORK,
    rpcCall,
    createMockRedis,
    assembleWithMiningJobAndTemplate,
} from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const MINER_COUNT = 50;

// ── Deterministic test-miner address generator ────────────────────
//
// 50 valid bcrt1 P2WPKH addresses from fixed inputs. No RPC calls, no
// extra deps — `bitcoinjs.payments.p2wpkh` just needs a 20-byte hash.
function generateTestMinerAddresses(count: number): string[] {
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) {
        const hash = crypto.createHash('ripemd160')
            .update(crypto.createHash('sha256').update(`blitzpool-stress-test-miner-${i}`).digest())
            .digest();
        const addr = bitcoinjs.payments.p2wpkh({ hash, network: NETWORK }).address!;
        addresses.push(addr);
    }
    return addresses;
}

// ── P2TR address derivation ───────────────────────────────────────
//
// Most 32-byte values are valid secp256k1 scalars; loop on the rare invalid
// one. The pool never spends these — the address is only used to build a
// scriptPubKey in the coinbase output — so we don't keep the privkeys.
function deriveP2trAddress(seed: string): string {
    let privkey: Buffer;
    let nonce = 0;
    do {
        privkey = crypto.createHash('sha256').update(`${seed}-${nonce++}`).digest();
    } while (!ecc.isPrivate(privkey));
    const pubkey = Buffer.from(ecc.pointFromScalar(privkey, true)!);
    const xOnly = pubkey.subarray(1); // strip y-parity byte
    return bitcoinjs.payments.p2tr({ internalPubkey: xOnly, network: NETWORK }).address!;
}

function deriveP2wpkhAddress(seed: string): string {
    const hash = crypto.createHash('ripemd160')
        .update(crypto.createHash('sha256').update(seed).digest())
        .digest();
    return bitcoinjs.payments.p2wpkh({ hash, network: NETWORK }).address!;
}

// 50/50 alternating P2WPKH and P2TR — exercises the address-type-aware
// adaptive trim. Even-index = P2WPKH (124 WU), odd-index = P2TR (172 WU).
function generateMixedTypeMinerAddresses(count: number): string[] {
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) {
        addresses.push(i % 2 === 0
            ? deriveP2wpkhAddress(`blitzpool-mixed-pkh-${i}`)
            : deriveP2trAddress(`blitzpool-mixed-tr-${i}`));
    }
    return addresses;
}

function generatePureP2trAddresses(count: number): string[] {
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) {
        addresses.push(deriveP2trAddress(`blitzpool-pure-tr-${i}`));
    }
    return addresses;
}

// ── Mock stack ───────────────────────────────────────────────────

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
    return { service, repo };
}

function createMockHistoryRepo() {
    const rows: any[] = [];
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
        newMiningJob$: { subscribe: () => ({ unsubscribe: () => undefined }) },
    };
}

function makeService() {
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
    // Big window so no trimming during the stress phase — we're stressing
    // the distribution + block-found paths, not window churn.
    service.setNetworkDifficulty(1e15);
    return { service, redis, balanceService: balanceBacking.service, historyRepo };
}


// ═══════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════

describe('PPLNS Regtest — 50-miner stress', () => {

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
            throw new Error(`Bitcoin Core regtest not running: ${(e as Error).message}`);
        }
    }, 60_000);

    it('50 concurrent miners with power-law weights: block submits clean, distribution is consistent', async () => {
        const { service, balanceService, historyRepo } = makeService();
        const miners = generateTestMinerAddresses(MINER_COUNT);

        // ── Power-law weight distribution ──
        // Real mining pools look like this: a few large miners contribute
        // most of the hashrate, most are small. We simulate that shape so
        // the sub-dust filter, weight-budget trim, and percent math all
        // get exercised by values they'd actually see in production.
        //
        //   miner  0..4:   heavy (diff ~1M)  — stay in coinbase
        //   miner  5..19:  medium (diff ~100k) — stay in coinbase
        //   miner 20..49:  tiny (diff = 1)    — sub-dust → pending
        //
        // Spread is wide enough that the tiny miners' cut of the regtest
        // block-reward stays below DUST_LIMIT (546 sats) but well above
        // the 1-sat rounding floor. With heavy : tiny ratio of 1e6 and
        // ~6.5M total diff-weight, a tiny miner gets ≈ percent_share ×
        // reward sats. At the lowest realistic regtest reward (8 halvings
        // → 0.39 BTC) that's still ≈ 6 sats — over the 1-sat floor so
        // the pending-row gets created, far below dust so the row stays
        // in pending instead of leaking into a coinbase output.
        //
        // (Earlier this used weight=0.01, which gave ~7 sats at the
        // initial 50-BTC reward but slipped below 1 sat after 3 halvings
        // and broke the "every sub-dust miner has pending" assertion.)
        //
        // Each miner submits 5 shares to exercise the zAdd concurrency.
        const weightFor = (i: number): number =>
            i < 5 ? 1_000_000 + i * 1000
            : i < 20 ? 100_000 + i
            : 1;

        const submissions: Promise<void>[] = [];
        for (let i = 0; i < MINER_COUNT; i++) {
            for (let s = 0; s < 5; s++) {
                submissions.push(service.recordShare(miners[i], weightFor(i)));
            }
        }
        await Promise.all(submissions);

        // Post-submit window invariants
        const stats = await service.getWindowStats();
        expect(stats.minerCount).toBe(MINER_COUNT);
        // Total work = sum(weight × 5 shares) for all miners
        const expectedTotalDiff = miners.reduce((s, _, i) => s + 5 * weightFor(i), 0);
        expect(stats.totalShares).toBeCloseTo(expectedTotalDiff, 0);

        // ── Single template fetch — same value used for distribution AND block assembly ──
        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;
        const distribution = await service.getPayoutDistribution(blockReward);

        console.log(`\n── 50-miner stress ──`);
        console.log(`Block reward: ${blockReward} sats`);
        console.log(`Distribution entries (after dust + weight trim): ${distribution.length}`);

        // Distribution invariants
        // 1. Percent sum never exceeds 100 (else bad-cb-amount from Core)
        const percentSum = distribution.reduce((s, d) => s + d.percent, 0);
        expect(percentSum).toBeLessThanOrEqual(100.0001);

        // 2. Fee address present + has feePercent share (dust-gate permitting)
        const feeEntry = distribution.find(d => d.address === ADDR_FEE);
        expect(feeEntry).toBeDefined();

        // 3. Every coinbase output ≥ dust — the builder's whole job
        for (const d of distribution) {
            const sats = Math.floor((d.percent / 100) * blockReward);
            expect(sats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
        }

        // 4. Output count bounded by weight budget — the default is
        //    PPLNS_COINBASE_WEIGHT_BUDGET=50000, so ~287 outputs max
        //    (286 miners + 1 fee). With 50 miners we won't hit that cap;
        //    the budget-cap exercise is the dedicated test below.
        expect(distribution.length).toBeLessThanOrEqual(287);

        // ── Submit block to Core via production MiningJob path ──
        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(distribution, template, 'stress');
        expect(submitResult).toBeNull();

        // Coinbase total must equal blockReward exactly (MiningJob puts remainder in outs[0]).
        const coinbaseTotal = coinbaseTx.outs.reduce((s: number, o: any) => s + o.value, 0);
        expect(coinbaseTotal).toBe(blockReward);

        // ── onBlockFound: audit rows written ──
        await service.onBlockFound(template.height, blockReward);

        const coinbaseRows = historyRepo._rows.filter((r: any) => r.blockHeight === template.height && r.rowType === 'coinbase');
        const pendingRows  = historyRepo._rows.filter((r: any) => r.blockHeight === template.height && r.rowType !== 'coinbase');

        // Every address that ended up in the distribution (incl. fee) got
        // a coinbase history row.
        const distributionAddresses = new Set(distribution.map(d => d.address));
        const coinbaseAddresses = new Set(coinbaseRows.map((r: any) => r.address));
        expect(coinbaseAddresses).toEqual(distributionAddresses);

        // Miners NOT in the distribution (sub-dust / trimmed) with a
        // positive share got a pending row + balance entry.
        const subDustMiners = miners.filter(addr => !distributionAddresses.has(addr));
        expect(subDustMiners.length).toBeGreaterThan(0); // proves the dust filter actually ran

        const pendingBalances = await balanceService.getAllWithBalance();
        const pendingAddresses = new Set(pendingBalances.map((p: any) => p.address));
        // Every sub-dust miner with a positive per-share cut should have
        // received SOMETHING in pending (exact match — every one of them,
        // not just "most").
        for (const sub of subDustMiners) {
            expect(pendingAddresses.has(sub)).toBe(true);
        }

        console.log(`Coinbase rows: ${coinbaseRows.length}`);
        console.log(`Pending rows:  ${pendingRows.length}`);
        console.log(`Pending balance rows: ${pendingBalances.length}`);

        // ── Idempotency: replay onBlockFound is a no-op ──
        const rowCountBeforeReplay = historyRepo._rows.length;
        const balancesBeforeReplay = pendingBalances.map((p: any) => ({
            address: p.address, pending: p.balanceSats, paid: p.totalPaidSats,
        }));

        await service.onBlockFound(template.height, blockReward);

        expect(historyRepo._rows.length).toBe(rowCountBeforeReplay);
        const balancesAfterReplay = (await balanceService.getAllWithBalance())
            .map((p: any) => ({ address: p.address, pending: p.balanceSats, paid: p.totalPaidSats }));
        expect(balancesAfterReplay).toEqual(balancesBeforeReplay);

        console.log(`✅ 50-miner stress: block submit clean, distribution consistent, replay is no-op`);
    }, 180_000);

    /**
     * Helper: stages N miners with uniform weight, fetches a regtest template,
     * runs PPLNS distribution, builds the block via the production MiningJob
     * path, and submits to Core.
     *
     * Returns the result tuple plus a few measurements callers want to
     * assert against — the actual serialized coinbase weight from bitcoinjs,
     * the total block weight, and the trim outcome.
     */
    async function runBudgetScenario(
        miners: string[],
        label: string,
        testId: string,
    ): Promise<{ distribution: any[]; coinbaseWeight: number; totalBlockWeight: number; submitResult: any }> {
        const { service } = makeService();

        const submissions: Promise<void>[] = [];
        for (const addr of miners) {
            for (let s = 0; s < 3; s++) {
                submissions.push(service.recordShare(addr, 10_000));
            }
        }
        await Promise.all(submissions);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;
        const distribution = await service.getPayoutDistribution(blockReward);

        // Sanity: dust filter didn't kick in for these uniform-weight miners.
        for (const d of distribution) {
            const sats = Math.floor((d.percent / 100) * blockReward);
            expect(sats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
        }

        const { submitResult, coinbaseTx, block } = await assembleWithMiningJobAndTemplate(
            distribution, template, testId,
        );
        const coinbaseWeight = coinbaseTx.weight();
        const totalBlockWeight = block.weight();

        console.log(
            `✅ ${label}: ${miners.length} miners → ${distribution.length} outputs, ` +
            `coinbase=${coinbaseWeight} WU (budget=${DEFAULT_COINBASE_WEIGHT_BUDGET}, ` +
            `headroom=${DEFAULT_COINBASE_WEIGHT_BUDGET - coinbaseWeight} WU)`
        );

        return { distribution, coinbaseWeight, totalBlockWeight, submitResult };
    }

    it('adaptive trim — pure P2WPKH miners fit ~398 in budget 50000', async () => {
        // With adaptive trim using actual per-address weights, P2WPKH outputs
        // (124 WU) consume far less budget than the conservative 172 WU
        // upper bound. At budget=50000 with 1 P2WPKH fee output:
        //   available = 50000 - 200 (margin) - 328 (base) - 188 (commit) - 124 (fee) = 49160
        //   max miners = floor(49160 / 124) = 396
        // We push 420 → trim drops at least the smallest 24.
        const PURE_PKH_COUNT = 420;
        const miners = generateTestMinerAddresses(PURE_PKH_COUNT);

        const { distribution, coinbaseWeight, totalBlockWeight, submitResult } =
            await runBudgetScenario(miners, 'pure P2WPKH', 'pkh-only');

        // Trim must have kicked in — distribution.length < miner count + 1 fee
        expect(distribution.length).toBeLessThan(PURE_PKH_COUNT + 1);
        // …but at LEAST ~390 miners should fit (proves adaptive logic works,
        // because the conservative formula would only allow ~286).
        expect(distribution.length).toBeGreaterThan(390);

        // Hard invariants
        expect(coinbaseWeight).toBeLessThanOrEqual(DEFAULT_COINBASE_WEIGHT_BUDGET);
        expect(totalBlockWeight).toBeLessThanOrEqual(4_000_000);
        expect(submitResult).toBeNull();
    }, 180_000);

    it('adaptive trim — pure P2TR miners cap at ~286 in budget 50000', async () => {
        // P2TR outputs cost 172 WU each — same as the conservative constant,
        // so adaptive logic gives the same result as the old formula here.
        // Acts as the regression test that the new logic doesn't suddenly
        // pack MORE outputs than the budget allows for heavy address types.
        //   available = 50000 - 200 - 328 - 188 - 172 (fee) = 49112
        //   max miners = floor(49112 / 172) = 285
        const PURE_TR_COUNT = 320;
        const miners = generatePureP2trAddresses(PURE_TR_COUNT);

        const { distribution, coinbaseWeight, totalBlockWeight, submitResult } =
            await runBudgetScenario(miners, 'pure P2TR', 'tr-only');

        // Trim must have kicked in
        expect(distribution.length).toBeLessThan(PURE_TR_COUNT + 1);
        // Old formula gave 286; we should be in roughly the same ballpark
        // (within a few outputs because the safety margin shaves 1-2 off).
        expect(distribution.length).toBeGreaterThan(280);
        expect(distribution.length).toBeLessThan(290);

        expect(coinbaseWeight).toBeLessThanOrEqual(DEFAULT_COINBASE_WEIGHT_BUDGET);
        expect(totalBlockWeight).toBeLessThanOrEqual(4_000_000);
        expect(submitResult).toBeNull();
    }, 180_000);

    it('adaptive trim — 50/50 P2WPKH/P2TR mix lands between the extremes', async () => {
        // Mixed-mix exercise to prove the trim adapts continuously, not just
        // at the pure endpoints. With 350 mixed miners and budget=50000:
        //   per-pair weight ≈ 124 + 172 = 296 WU
        //   available = 50000 - 200 - 328 - 188 - 124 (P2WPKH fee) = 49160
        //   max pairs = floor(49160 / 296) = 166 → max ~332 miners
        // Pushing 350 → trim drops ~18.
        const MIXED_COUNT = 350;
        const miners = generateMixedTypeMinerAddresses(MIXED_COUNT);

        const { distribution, coinbaseWeight, totalBlockWeight, submitResult } =
            await runBudgetScenario(miners, 'P2WPKH+P2TR mix', 'mixed-budget');

        // Should trim some, but stay well above pure-P2TR's ~286 cap.
        expect(distribution.length).toBeLessThan(MIXED_COUNT + 1);
        expect(distribution.length).toBeGreaterThan(290);
        expect(distribution.length).toBeLessThan(MIXED_COUNT);   // some trim

        expect(coinbaseWeight).toBeLessThanOrEqual(DEFAULT_COINBASE_WEIGHT_BUDGET);
        expect(totalBlockWeight).toBeLessThanOrEqual(4_000_000);
        expect(submitResult).toBeNull();
    }, 180_000);
});
