/**
 * Group-Solo Regtest Integration Tests — Lifecycle scenarios.
 *
 * Three scenarios exercised against a live Bitcoin Core regtest node,
 * each ending in a block submit so we prove the coinbase math matches
 * what bitcoind will accept:
 *
 *   1. kick-redistribute  — kicking a member flushes their pending into
 *                            the remaining members; on the next block
 *                            the coinbase has no output for the kicked
 *                            miner and the survivors' pending carries
 *                            the redistribution.
 *
 *   2. dust-fee-gate      — when feePercent * blockRewardSats < 546 sat
 *                            the fee output is silently dropped and
 *                            miners keep 100 % of the block. The block
 *                            must still validate with the reduced
 *                            output set.
 *
 *   3. snapshot-persist   — getPayoutDistribution writes the snapshot to
 *                            Redis; we spin up a fresh GroupSoloService
 *                            instance (simulating a pool restart), feed
 *                            it the same Redis backing store, and call
 *                            onBlockFound. It must use the persisted
 *                            snapshot, not the current-window fallback.
 *
 * Block builder copied from group-solo-regtest.spec.ts — same
 * invariants: height ≥ 17 for BIP34 scriptSig encoding, witness
 * commitment computed over (dummyCoinbase + template transactions),
 * block submitted with block.toHex(false) (no witnesses on outer
 * serialization; Core picks up witnesses from the txs themselves).
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as http from 'http';
import { GroupSoloService } from './group-solo.service';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
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

// ── Shared mock stack ──────────────────────────────────────────────

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
        zRem: async (key: string, value: string) => {
            const z = getZ(key);
            const idx = z.findIndex(e => e.value === value);
            if (idx >= 0) z.splice(idx, 1);
        },
        hSet: async (key: string, field: string, value: string) => { getH(key).set(field, value); },
        hGet: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
        hDel: async (key: string, field: string) => { hashes.get(key)?.delete(field); },
        hGetAll: async (key: string) => {
            const h = hashes.get(key);
            return h ? Object.fromEntries(h.entries()) : {};
        },
        hIncrByFloat: async (key: string, field: string, amount: number) => {
            const h = getH(key);
            const v = parseFloat(h.get(field) ?? '0') + amount;
            h.set(field, v.toString());
            return v;
        },
        _store: store,
        _zsets: zsets,
        _hashes: hashes,
    };
}

function createMockRepo<T>() {
    const rows: T[] = [];
    const applySave = (row: T) => {
        const r = row as any;
        let existing: any = null;
        if (r?.id !== undefined) {
            existing = (rows as any[]).find(x => x.id === r.id);
        } else if (r?.address !== undefined && r?.groupId !== undefined) {
            existing = (rows as any[]).find(x => x.address === r.address && x.groupId === r.groupId);
        } else if (r?.address !== undefined) {
            existing = (rows as any[]).find(x => x.address === r.address);
        }
        if (existing) Object.assign(existing, row);
        else rows.push(row);
    };
    return {
        save: async (arg: T | T[]) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) applySave(row);
            return arg;
        },
        insert: async (arg: T | T[]) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        },
        create: (partial: Partial<T>) => ({ ...partial }) as T,
        find: async (query?: any) => {
            if (!query?.where) return [...rows];
            return (rows as any[]).filter(r =>
                Object.entries(query.where).every(([k, v]) => {
                    if (v && typeof v === 'object' && Array.isArray((v as any)._value)) {
                        return new Set((v as any)._value).has(r[k]);
                    }
                    return r[k] === v;
                }),
            );
        },
        findOneBy: async (where: any) =>
            (rows as any[]).find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
        delete: async (where: any) => {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (Object.entries(where).every(([k, v]) => (rows[i] as any)[k] === v)) {
                    rows.splice(i, 1);
                }
            }
        },
        update: async (where: any, patch: any) => {
            for (const row of rows as any[]) {
                if (Object.entries(where).every(([k, v]) => row[k] === v)) Object.assign(row, patch);
            }
            return { affected: 0 } as any;
        },
        _rows: rows,
    };
}

function makeService(env: Record<string, string>) {
    const addressToGroup = new Map<string, { groupId: string; active: boolean }>();
    addressToGroup.set(ADDR_ALICE, { groupId: 'grp-1', active: true });
    addressToGroup.set(ADDR_BOB, { groupId: 'grp-1', active: true });
    addressToGroup.set(ADDR_CHARLIE, { groupId: 'grp-1', active: true });

    const balanceRepo = createMockRepo();
    const historyRepo = createMockRepo();
    attachMockTxManager([
        [PplnsGroupBlockHistoryEntity, historyRepo],
        [PplnsGroupBalanceEntity, balanceRepo],
    ]);
    const service = new GroupSoloService(
        { get: (k: string) => env[k] } as any,
        { store: {} } as any,
        historyRepo as any,
        balanceRepo as any,
        { getGroupForAddress: (a: string) => addressToGroup.get(a) } as any,
    );
    const redis = createMockRedis();
    (service as any).redis = redis;
    (service as any).enabled = true;
    return { service, redis, balanceRepo, historyRepo, addressToGroup };
}

// ── Block Builder (same pattern as group-solo-regtest.spec.ts) ──

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
        Buffer.from('blitzpool-lifecycle-test'),
        Buffer.alloc(4, 0),
    ]);
    tx.ins[0].witness = [Buffer.alloc(32, 0)];
    for (const payout of payouts) {
        const script = bitcoinjs.address.toOutputScript(payout.address, NETWORK);
        tx.addOutput(script, payout.sats);
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

/**
 * Pull a fresh getblocktemplate, build coinbase from the distribution,
 * compute the right witness commitment, mine and submit the block.
 * Returns the template + decision result; verify null == success.
 */
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
    const mined = mineBlock(block, template.target);
    if (!mined) throw new Error('mineBlock exhausted nonce range');

    const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
    return { template, blockReward, payouts, submitResult };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Group-Solo Regtest Lifecycle', () => {

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
            // Need chain height ≥ 17 for BIP34 scriptSig encoding.
            if (info.blocks < 17) {
                try { await rpcCall('createwallet', ['default']); } catch { /* already */ }
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch (e) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443 — ${(e as Error).message}`);
        }
    });

    // ── 1. Kick redistributes pending; next block validates without kicked output ───
    it('kick-redistribute: survivors absorb pending, block validates without kicked output', async () => {
        const { service, balanceRepo, addressToGroup } = makeService({
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
        });

        // Seed Charlie with pending from an earlier sub-dust round.
        (balanceRepo._rows as any[]).push({
            address: ADDR_CHARLIE, groupId: 'grp-1', pendingSats: 900, totalPaidSats: 0,
        });

        // Alice + Bob + Charlie all mine this round.
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);
        await service.recordShare(ADDR_CHARLIE, 300);

        // Admin kicks Charlie; survivors are Alice + Bob.
        await service.removeMemberState('grp-1', ADDR_CHARLIE, [ADDR_ALICE, ADDR_BOB]);

        // Charlie's 900 sats pending splits 450/450 into Alice + Bob.
        const aliceRow = (balanceRepo._rows as any[]).find(r => r.address === ADDR_ALICE);
        const bobRow = (balanceRepo._rows as any[]).find(r => r.address === ADDR_BOB);
        expect(aliceRow?.pendingSats).toBe(450);
        expect(bobRow?.pendingSats).toBe(450);
        expect((balanceRepo._rows as any[]).find(r => r.address === ADDR_CHARLIE)).toBeUndefined();

        // Charlie stops mining.
        addressToGroup.delete(ADDR_CHARLIE);

        // Build distribution → submit block to Core.
        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution('grp-1', template.coinbasevalue);

        // No Charlie in the distribution.
        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_CHARLIE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB, ADDR_FEE].sort());

        const { submitResult, template: usedTemplate } = await assembleAndSubmitBlock(distribution);
        expect(submitResult).toBeNull();

        // onBlockFound rolls Alice + Bob pending into totalPaidSats.
        await service.onBlockFound(usedTemplate.height, usedTemplate.coinbasevalue, ADDR_ALICE);
        const aliceAfter = (balanceRepo._rows as any[]).find(r => r.address === ADDR_ALICE);
        const bobAfter = (balanceRepo._rows as any[]).find(r => r.address === ADDR_BOB);
        expect(aliceAfter?.pendingSats).toBe(0);
        expect(aliceAfter?.totalPaidSats).toBe(450);
        expect(bobAfter?.pendingSats).toBe(0);
        expect(bobAfter?.totalPaidSats).toBe(450);

        console.log('✅ kick-redistribute: survivors absorbed charlie\'s pending, block validated');
    }, 120000);

    // ── 2. Dust-fee gate drops the fee output; block still validates ──
    it('dust-fee-gate: tiny feePercent → fee omitted, miners keep 100 %, block valid', async () => {
        // On regtest the subsidy is 50 BTC = 5_000_000_000 sats at early
        // heights. 0.00001 % → 0.0000001 × 5e9 = 500 sats < DUST_LIMIT 546.
        const { service } = makeService({
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '0.00001',
        });

        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution('grp-1', template.coinbasevalue);

        // Dust-gate must drop the fee output.
        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_FEE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB].sort());

        // Miners together should receive effectively 100 % (remainder
        // sweep into the first miner when no fee address).
        const totalPercent = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPercent).toBeCloseTo(100, 5);

        const { submitResult } = await assembleAndSubmitBlock(distribution);
        expect(submitResult).toBeNull();

        console.log('✅ dust-fee-gate: fee omitted from coinbase, block accepted');
    }, 120000);

    // ── 3. Snapshot persists across service-instance restart ──────
    it('snapshot-persist: distribution snapshot survives service restart via Redis', async () => {
        const env = {
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
        };
        const { service: svcA, redis, balanceRepo, historyRepo, addressToGroup } = makeService(env);

        await svcA.recordShare(ADDR_ALICE, 100);
        await svcA.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;

        // svcA writes the snapshot (simulating the moment the miner
        // receives the coinbase template).
        const distributionA = await svcA.getPayoutDistribution('grp-1', blockReward);
        expect(redis._store.get(`groupsolo:grp-1:snapshot`)).toBeTruthy();

        // Simulate pool restart: new service instance, same Redis.
        const svcB = new GroupSoloService(
            { get: (k: string) => env[k] } as any,
            { store: {} } as any,
            historyRepo as any,
            balanceRepo as any,
            { getGroupForAddress: (a: string) => addressToGroup.get(a) } as any,
        );
        (svcB as any).redis = redis;
        (svcB as any).enabled = true;
        // svcB.snapshots is a fresh empty Map — if the service used
        // only in-memory state, it would fall back to
        // onBlockFoundFromWindow and book payouts differently.

        const { submitResult, template: usedTemplate } = await assembleAndSubmitBlock(distributionA);
        expect(submitResult).toBeNull();

        // onBlockFound on svcB must read from Redis.
        await svcB.onBlockFound(usedTemplate.height, usedTemplate.coinbasevalue, ADDR_ALICE);

        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === usedTemplate.height && r.inCoinbase === true,
        );
        expect(historyForBlock.length).toBe(distributionA.length);
        expect(historyForBlock.map(r => r.address).sort())
            .toEqual(distributionA.map(d => d.address).sort());

        // Snapshot key consumed.
        expect(redis._store.get(`groupsolo:grp-1:snapshot`)).toBeUndefined();

        console.log('✅ snapshot-persist: fresh service instance consumed Redis snapshot');
    }, 120000);
});
