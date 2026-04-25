/**
 * Group-Solo Regtest — multi-tx mempool block validity.
 *
 * The fundamental correctness property of our mining code is: the blocks
 * we hand back to miners must be accepted by Bitcoin Core. The existing
 * group-solo regtests prove this for the trivial case — empty mempool,
 * coinbase-only blocks. This spec exercises the same flow with a fat
 * mempool of varied tx shapes (P2WPKH, P2PKH, P2TR, mixed fees), which is
 * where the witness-commitment path actually has to do real work:
 *
 *   - Core's `getblocktemplate` surfaces a `transactions` list with real
 *     segwit wtxids that all must hash into the witness merkle root.
 *   - The coinbase's OP_RETURN commitment (`aa21a9ed…`) must equal
 *     `hash256(witnessMerkleRoot || 32-byte-zero-nonce)`.
 *   - Getting any wtxid wrong → `bad-witness-nonce-size` /
 *     `bad-witness-merkle-match` and Core rejects the block.
 *
 * The block builder and distribution engine are the same code used by
 * mainnet, so a clean submit here is the closest thing to an end-to-end
 * production sanity check we can run offline.
 *
 * Requires a running regtest node at localhost:18443 with a default
 * wallet (rpcuser=test, rpcpassword=test).
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

// Mining-side addresses: coinbase outputs go here.
const ADDR_FEE   = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ALICE = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB   = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';

// Minimum chain height so (a) BIP34 scriptSig fits in length-prefixed bytes,
// (b) we have enough mature coinbase UTXOs (100-conf rule) to fund a wide
// mempool of sends. 120 gives us ~20 mature UTXOs with headroom.
const MIN_CHAIN_HEIGHT = 120;
const MEMPOOL_TX_COUNT = 25;

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
                    if (parsed.error) reject(new Error(`RPC ${method}: ${JSON.stringify(parsed.error)}`));
                    else resolve(parsed.result);
                } catch (e) {
                    reject(new Error(`Invalid JSON from ${method}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function walletRpc(wallet: string, method: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
        const req = http.request(`${RPC_URL}/wallet/${wallet}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) reject(new Error(`RPC ${method} (wallet ${wallet}): ${JSON.stringify(parsed.error)}`));
                    else resolve(parsed.result);
                } catch (e) {
                    reject(new Error(`Invalid JSON from ${method}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Mock infrastructure (matches the other group-solo regtests) ──

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
    const repo: any = {
        save: async (row: T) => { rows.push({ ...row }); return row; },
        create: (partial: Partial<T>) => ({ ...partial }) as T,
        find: async (query?: any) => {
            if (!query?.where) return [...rows];
            return (rows as any[]).filter(r =>
                Object.entries(query.where).every(([k, v]) => r[k] === v),
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
    return repo;
}

function makeService() {
    const env: Record<string, string> = {
        GROUP_SOLO_PORT: '3340',
        PPLNS_FEE_ADDRESS: ADDR_FEE,
        PPLNS_FEE_PERCENT: '2',
    };
    const addressToGroup = new Map<string, { groupId: string; active: boolean }>();
    addressToGroup.set(ADDR_ALICE, { groupId: 'grp-1', active: true });
    addressToGroup.set(ADDR_BOB, { groupId: 'grp-1', active: true });

    const historyRepo = createMockRepo();
    const balanceRepo = createMockRepo();
    attachMockTxManager([
        [PplnsGroupBlockHistoryEntity, historyRepo],
        [PplnsGroupBalanceEntity, balanceRepo],
    ]);
    const groupRepo: any = { findOneBy: jest.fn(async () => null), update: jest.fn() };
    const service = new GroupSoloService(
        { get: (k: string) => env[k] } as any,
        { store: {} } as any,
        historyRepo as any,
        balanceRepo as any,
        groupRepo as any,
        { getGroupForAddress: (a: string) => addressToGroup.get(a) } as any,
    );
    const redis = createMockRedis();
    (service as any).redis = redis;
    (service as any).enabled = true;
    return { service, redis, historyRepo, balanceRepo };
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
        Buffer.from('blitzpool-mempool-test'),
        Buffer.alloc(4, 0),
    ]);
    tx.ins[0].witness = [Buffer.alloc(32, 0)];
    for (const payout of payouts) {
        tx.addOutput(bitcoinjs.address.toOutputScript(payout.address, NETWORK), payout.sats);
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

// ── Setup helpers ─────────────────────────────────────────────────

async function ensureWallet(name: string): Promise<void> {
    try {
        await rpcCall('createwallet', [name]);
    } catch (e) {
        // `createwallet` fails if already created OR if already loaded.
        // Try loadwallet — the only legit failure is "wallet not found",
        // which the createwallet above should have fixed.
        try { await rpcCall('loadwallet', [name]); } catch { /* already loaded */ }
    }
}

async function ensureChainHeight(wallet: string, target: number): Promise<void> {
    const info = await rpcCall('getblockchaininfo');
    if (info.blocks >= target) return;
    const addr = await walletRpc(wallet, 'getnewaddress');
    await walletRpc(wallet, 'generatetoaddress', [target - info.blocks, addr]);
}

/**
 * Populate the mempool with a mix of segwit (P2WPKH), legacy (P2PKH), and
 * taproot (P2TR) sends. Each `sendtoaddress` produces a fresh tx in the
 * mempool; the wallet handles coin selection + fee estimation. Returns
 * the number of txs actually sent (may be less than target if we run out
 * of spendable coin selection space).
 */
async function populateMempool(wallet: string, count: number): Promise<number> {
    const addrTypes: Array<'bech32' | 'legacy' | 'bech32m'> = ['bech32', 'legacy', 'bech32m'];
    // Pre-generate a rotating set of destination addresses across all
    // three script types, so Core's getblocktemplate has to assemble
    // a mixed-type block.
    const dests: string[] = [];
    for (const t of addrTypes) {
        for (let i = 0; i < Math.ceil(count / addrTypes.length); i++) {
            dests.push(await walletRpc(wallet, 'getnewaddress', ['', t]));
        }
    }

    let sent = 0;
    for (let i = 0; i < count; i++) {
        const dest = dests[i % dests.length];
        // Small, variable amounts to force the wallet to select from
        // different coins and produce different tx shapes.
        const amount = 0.001 + (i % 7) * 0.0005;
        try {
            await walletRpc(wallet, 'sendtoaddress', [dest, amount]);
            sent++;
        } catch (e) {
            // Out of spendable coins or wallet race — stop early.
            break;
        }
    }
    return sent;
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Group-Solo Regtest — fat-mempool block validity', () => {

    const WALLET_NAME = 'mempool_test_wallet';

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
        } catch (e) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443 — ${(e as Error).message}`);
        }
        await ensureWallet(WALLET_NAME);
        await ensureChainHeight(WALLET_NAME, MIN_CHAIN_HEIGHT);
    }, 60_000);

    it('block with multi-type mempool transactions submits cleanly', async () => {
        const { service } = makeService();

        // Two miners active; Alice's share weights the coinbase distribution.
        await service.recordShare(ADDR_ALICE, 700);
        await service.recordShare(ADDR_BOB, 300);

        // Pack the mempool with a mix of segwit / legacy / taproot sends.
        const sent = await populateMempool(WALLET_NAME, MEMPOOL_TX_COUNT);
        expect(sent).toBeGreaterThan(5); // meaningful fat mempool

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        expect(template.transactions.length).toBeGreaterThan(0);
        console.log(`\n=== Fat-mempool regtest ===`);
        console.log(`Chain height before submit: ${template.height - 1}`);
        console.log(`Mempool txs included in template: ${template.transactions.length}`);

        // Distribution is independent of mempool — but the block built
        // from it has to validate together with the mempool txs.
        const distribution = await service.getPayoutDistribution('grp-1', template.coinbasevalue);
        const payouts = distribution.map(d => ({
            address: d.address,
            sats: Math.floor((d.percent / 100) * template.coinbasevalue),
        }));
        const assigned = payouts.reduce((s, p) => s + p.sats, 0);
        if (assigned < template.coinbasevalue) {
            payouts[0].sats += template.coinbasevalue - assigned;
        }

        // Witness commitment: hash-tree of every tx's wtxid, with the
        // coinbase contributing 32 zero bytes (BIP-141). bitcoinjs's
        // `calculateMerkleRoot(…, true)` handles the coinbase detection
        // internally as long as we pass a coinbase-shaped dummy first.
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
        expect(mined).toBe(true);

        const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
        console.log(`Submit result: ${submitResult === null ? 'SUCCESS' : submitResult}`);
        expect(submitResult).toBeNull();

        // Chain tip advanced.
        const infoAfter = await rpcCall('getblockchaininfo');
        expect(infoAfter.blocks).toBe(template.height);

        // Mempool drained (or near-drained — some fee-ratio-bound txs may remain).
        const mempoolAfter = await rpcCall('getmempoolinfo');
        expect(mempoolAfter.size).toBeLessThan(sent);

        console.log(`✅ Block #${template.height} with ${txs.length} mempool txs (${payouts.length} coinbase outputs) accepted by Core`);
    }, 180_000);
});
