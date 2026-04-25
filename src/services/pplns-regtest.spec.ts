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

import * as bitcoinjs from 'bitcoinjs-lib';
import * as http from 'http';
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';

const RPC_URL = 'http://127.0.0.1:18443';
const RPC_USER = 'test';
const RPC_PASS = 'test';
const NETWORK = bitcoinjs.networks.regtest;

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ALICE = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';
const ADDR_CHARLIE = 'bcrt1qlppw7cnqspnky6qzv8p2n468lpvwuct7ehp7l2';

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

// ── Redis mock (same shape as group-solo regtest, matches PPLNS keys) ──

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
            const e = end === -1 ? z.length - 1 : end;
            z.splice(start, e - start + 1);
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

// ── Block Builder (same pattern as group-solo regtest) ──

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
        Buffer.from('blitzpool-pplns-regtest'),
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

function buildBlock(template: any, coinbaseTx: bitcoinjs.Transaction, transactions: bitcoinjs.Transaction[]): bitcoinjs.Block {
    const block = new bitcoinjs.Block();
    block.version = template.version;
    block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
    block.timestamp = template.curtime;
    block.bits = parseInt(template.bits, 16);
    block.nonce = 0;
    block.transactions = [coinbaseTx, ...transactions];
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
    if (!mineBlock(block, template.target)) throw new Error('mine nonce exhausted');

    const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
    return { template, blockReward, payouts, submitResult };
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
        const { service, balanceService } = makeService();

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

        // And Core must accept the block.
        const { submitResult } = await assembleAndSubmitBlock(distribution);
        expect(submitResult).toBeNull();

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

        // Build + submit the block using A's distribution.
        const { submitResult } = await assembleAndSubmitBlock(distributionA);
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
        const { service } = makeService({ feePercent: '0.00001' });
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 100);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_FEE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB].sort());

        const { submitResult } = await assembleAndSubmitBlock(distribution);
        expect(submitResult).toBeNull();

        console.log('✅ PPLNS dust-fee-gate: fee omitted, miners keep 100 %, block accepted');
    }, 120000);
});
