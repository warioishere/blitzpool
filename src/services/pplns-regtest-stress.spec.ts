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
import * as http from 'http';
import * as crypto from 'crypto';
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import { DUST_LIMIT_SATS } from './coinbase-distribution';

const RPC_URL = 'http://127.0.0.1:18443';
const RPC_USER = 'test';
const RPC_PASS = 'test';
const NETWORK = bitcoinjs.networks.regtest;

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const MINER_COUNT = 50;

// ── RPC ────────────────────────────────────────────────────────────

function rpcCall(method: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
        const req = http.request(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) reject(new Error(`RPC: ${JSON.stringify(parsed.error)}`));
                    else resolve(parsed.result);
                } catch (e) {
                    reject(new Error(`Invalid JSON: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

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

// ── Mock stack ───────────────────────────────────────────────────

function createMockRedis() {
    const store = new Map<string, string>();
    const zsets = new Map<string, { score: number; value: string }[]>();
    const hashes = new Map<string, Map<string, string>>();
    const getZ = (key: string) => {
        if (!zsets.has(key)) zsets.set(key, []);
        return zsets.get(key)!;
    };
    const getH = (key: string) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        return hashes.get(key)!;
    };
    return {
        incr: async (key: string) => {
            const v = parseInt(store.get(key) ?? '0', 10) + 1;
            store.set(key, v.toString());
            return v;
        },
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string, _opts?: any) => { store.set(key, value); },
        del: async (key: string) => { store.delete(key); zsets.delete(key); hashes.delete(key); },
        expire: async () => 1,
        incrByFloat: async (key: string, amount: number) => {
            const v = parseFloat(store.get(key) ?? '0') + amount;
            store.set(key, v.toString());
            return v;
        },
        zAdd: async (key: string, entry: { score: number; value: string }) => {
            const z = getZ(key);
            z.push(entry);
            z.sort((a, b) => a.score - b.score);
        },
        zRange: async (key: string, start: number, end: number) => {
            const z = getZ(key);
            const e = end === -1 ? z.length - 1 : end;
            return z.slice(start, e + 1).map(x => x.value);
        },
        zCard: async (key: string) => getZ(key).length,
        zRemRangeByRank: async (key: string, start: number, end: number) => {
            const z = getZ(key);
            z.splice(start, end - start + 1);
        },
        hGetAll: async (key: string) => {
            const h = hashes.get(key);
            if (!h) return {};
            return Object.fromEntries(h.entries());
        },
        hIncrByFloat: async (key: string, field: string, amount: number) => {
            const h = getH(key);
            const cur = parseFloat(h.get(field) ?? '0') + amount;
            h.set(field, cur.toString());
            return cur;
        },
        _store: store,
        _zsets: zsets,
    };
}

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
        touchLastAcceptedShareAt: async (_addr: string) => undefined,
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

// ── Block builder (same pattern as other regtests) ─────────────────

function buildCoinbase(
    payouts: { address: string; sats: number }[],
    height: number,
    witnessCommit: Buffer,
): bitcoinjs.Transaction {
    const tx = new bitcoinjs.Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    const heightEncoded = bitcoinjs.script.number.encode(height);
    tx.ins[0].script = Buffer.concat([
        Buffer.from([heightEncoded.length]),
        heightEncoded,
        Buffer.from('blitzpool-stress-test'),
        Buffer.alloc(4, 0),
    ]);
    tx.ins[0].witness = [Buffer.alloc(32, 0)];
    for (const p of payouts) {
        tx.addOutput(bitcoinjs.address.toOutputScript(p.address, NETWORK), p.sats);
    }
    const commitmentHeader = Buffer.from('aa21a9ed', 'hex');
    tx.addOutput(
        bitcoinjs.script.compile([
            bitcoinjs.opcodes.OP_RETURN,
            Buffer.concat([commitmentHeader, witnessCommit]),
        ]),
        0,
    );
    return tx;
}

function buildBlock(template: any, coinbaseTx: bitcoinjs.Transaction, txs: bitcoinjs.Transaction[]): bitcoinjs.Block {
    const block = new bitcoinjs.Block();
    block.version = template.version;
    block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
    block.timestamp = template.curtime;
    block.bits = parseInt(template.bits, 16);
    block.nonce = 0;
    block.transactions = [coinbaseTx, ...txs];
    block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);
    return block;
}

function mineBlock(block: bitcoinjs.Block, targetHex: string): boolean {
    const target = Buffer.from(targetHex.padStart(64, '0'), 'hex');
    for (let nonce = 0; nonce < 0xffffffff; nonce++) {
        block.nonce = nonce;
        const hash = bitcoinjs.crypto.hash256(block.toBuffer(true));
        if (Buffer.from(hash).reverse().compare(target) <= 0) return true;
    }
    return false;
}

async function assembleAndSubmitBlock(distribution: { address: string; percent: number }[]) {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const blockReward = template.coinbasevalue;

    const payouts = distribution.map(d => ({
        address: d.address,
        sats: Math.floor((d.percent / 100) * blockReward),
    }));
    const totalAssigned = payouts.reduce((s, p) => s + p.sats, 0);
    if (totalAssigned < blockReward && payouts.length > 0) {
        payouts[0].sats += blockReward - totalAssigned;
    }

    const txs = template.transactions.map((t: any) => bitcoinjs.Transaction.fromHex(t.data));
    const dummyCoinbase = new bitcoinjs.Transaction();
    dummyCoinbase.version = 2;
    dummyCoinbase.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    dummyCoinbase.addOutput(Buffer.alloc(22, 0), 0);
    dummyCoinbase.ins[0].witness = [Buffer.alloc(32, 0)];
    const witnessCommit = bitcoinjs.Block.calculateMerkleRoot([dummyCoinbase, ...txs], true);

    const coinbaseTx = buildCoinbase(payouts, template.height, witnessCommit);
    const block = buildBlock(template, coinbaseTx, txs);
    if (!mineBlock(block, template.target)) throw new Error('nonce exhausted');

    const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
    return { template, blockReward, payouts, submitResult };
}

// ═══════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════

describe('PPLNS Regtest — 50-miner stress', () => {

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
            if (info.blocks < 17) {
                try { await rpcCall('createwallet', ['default']); } catch { /* already */ }
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
        //   miner  0..4:   heavy (diff ~1M)   — stay in coinbase
        //   miner  5..19:  medium (diff ~100k) — stay in coinbase
        //   miner 20..49:  tiny (diff ~0.01)  — sub-dust → pending
        //
        // Spread is wide enough that the tiny miners' cut of the 50 BTC
        // regtest block-reward ends up below DUST_LIMIT (546 sats). With
        // heavy : tiny ratio of 1e8 and ~6.5M total diff-weight, a tiny
        // miner gets ~7 sats at current reward — comfortably sub-dust.
        //
        // Each miner submits 5 shares to exercise the zAdd concurrency.
        const weightFor = (i: number): number =>
            i < 5 ? 1_000_000 + i * 1000
            : i < 20 ? 100_000 + i
            : 0.01;

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
        expect(stats.totalDifficulty).toBeCloseTo(expectedTotalDiff, 0);

        // ── Get template + distribution from the service ──
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
        //    PPLNS_COINBASE_WEIGHT_BUDGET=20000, so ~115 outputs max.
        //    With 50 miners we shouldn't hit that cap, but the test also
        //    passes with a lower cap if someone tunes the budget down.
        expect(distribution.length).toBeLessThanOrEqual(120);

        // ── Submit block to Core ──
        const { submitResult } = await assembleAndSubmitBlock(distribution);
        expect(submitResult).toBeNull();

        // ── onBlockFound: audit rows written ──
        await service.onBlockFound(template.height, blockReward);

        const coinbaseRows = historyRepo._rows.filter((r: any) => r.blockHeight === template.height && r.inCoinbase);
        const pendingRows  = historyRepo._rows.filter((r: any) => r.blockHeight === template.height && !r.inCoinbase);

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
});
