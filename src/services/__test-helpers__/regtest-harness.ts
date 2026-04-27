/**
 * Shared scaffolding for the *-regtest.spec.ts suite.
 *
 * The regtest specs all sit on top of:
 *   - one shared bitcoind (run sequentially via --runInBand),
 *   - the same JSON-RPC client (`rpcCall`),
 *   - the same MiningJob-based block assembly (`assembleWithMiningJobAndTemplate`),
 *   - in-memory fakes for the Redis client and TypeORM repos that
 *     each suite was previously copying line-for-line.
 *
 * The fakes here are SUPERSETS — every method any single spec used
 * is available — so individual specs can drop their local duplicates
 * without losing capability.
 */
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import * as http from 'http';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';

import { MiningJob } from '../../models/MiningJob';
import { IJobTemplate } from '../stratum-v1-jobs.service';

// initEccLib is required for P2TR address support (bitcoinjs-lib).
bitcoinjs.initEccLib(ecc);

// ── Constants every spec was redeclaring ──────────────────────────

export const RPC_URL = 'http://127.0.0.1:18443';
export const RPC_USER = 'test';
export const RPC_PASS = 'test';
export const NETWORK = bitcoinjs.networks.regtest;

// ── JSON-RPC client ───────────────────────────────────────────────

export function rpcCall(method: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
        const req = http.request(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
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

// ── MiningJob helpers (production-path block assembly) ───────────

/**
 * Build an IJobTemplate from a raw getblocktemplate response.
 * Uses a temporary dummy coinbase to compute merkle branches and the
 * witness commitment; the real coinbase is slotted in by MiningJob.
 * `block.merkleRoot` is left as a placeholder — copyAndUpdateBlock
 * recomputes it from the actual coinbase + extranonces.
 */
export function buildJobTemplate(template: any, idSuffix: string): IJobTemplate {
    const transactions = template.transactions.map((t: any) => bitcoinjs.Transaction.fromHex(t.data));

    const tempCoinbaseTx = new bitcoinjs.Transaction();
    tempCoinbaseTx.version = 2;
    tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
    const txsWithDummy = [tempCoinbaseTx, ...transactions];

    const transactionBuffers = txsWithDummy.map(tx => tx.getHash(false));
    const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
    const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter((h: any) => h != null);
    merkleBranches.pop(); // drop root
    const merkle_branch = merkleBranches.slice(1).map((b: Buffer) => b.toString('hex'));

    const block = new bitcoinjs.Block();
    block.version = template.version;
    block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
    block.timestamp = template.curtime;
    block.bits = parseInt(template.bits, 16);
    block.merkleRoot = Buffer.alloc(32); // placeholder; MiningJob.copyAndUpdateBlock recomputes
    block.transactions = txsWithDummy;
    block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(txsWithDummy, true);

    return {
        block,
        merkle_branch,
        blockData: {
            id: `regtest-${idSuffix}`,
            creation: Date.now(),
            coinbasevalue: template.coinbasevalue,
            networkDifficulty: 1,
            height: template.height,
            clearJobs: true,
        },
    };
}

/** Minimal ConfigService stub — sufficient for MiningJob constructor. */
export function makeConfigService(poolIdentifier = 'blitzpool-regtest'): any {
    return { get: (k: string) => k === 'POOL_IDENTIFIER' ? poolIdentifier : undefined };
}

/**
 * Build a block via the production MiningJob path and submit it to the
 * regtest node. Uses an already-fetched `template` so the coinbase value
 * matches exactly what was used for `getPayoutDistribution`.
 *
 * This is the exact path a Stratum V1 client goes through:
 *   MiningJob(distribution) → copyAndUpdateBlock → submitblock
 */
export async function assembleWithMiningJobAndTemplate(
    distribution: { address: string; percent: number }[],
    template: any,
    testId: string,
    configService?: any,
): Promise<{ submitResult: any; coinbaseTx: bitcoinjs.Transaction; miningJob: MiningJob; block: bitcoinjs.Block }> {
    const jobTemplate = buildJobTemplate(template, testId);
    const cs = configService ?? makeConfigService();

    const miningJob = new MiningJob(cs, NETWORK, `job-${testId}`, distribution, jobTemplate);
    const block = miningJob.copyAndUpdateBlock(jobTemplate, 0, 0, '00000000', '00000000', template.curtime);

    if (!mineBlock(block, template.target)) throw new Error('nonce exhausted');

    const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
    const coinbaseTx = miningJob.cloneCoinbaseTransaction();

    return { submitResult, coinbaseTx, miningJob, block };
}

// ── Nonce grinder ─────────────────────────────────────────────────

/** Naive nonce grinder — fine for regtest (target = 0x7fffff…). */
export function mineBlock(block: bitcoinjs.Block, targetHex: string): boolean {
    const target = Buffer.from(targetHex.padStart(64, '0'), 'hex');
    for (let nonce = 0; nonce < 0xffffffff; nonce++) {
        block.nonce = nonce;
        const hash = bitcoinjs.crypto.hash256(block.toBuffer(true));
        if (Buffer.from(hash).reverse().compare(target) <= 0) return true;
    }
    return false;
}

// ── In-memory Redis fake ──────────────────────────────────────────

/**
 * Lightweight stand-in for the node-redis client. Implements the
 * SUPERSET of methods needed by the regtest specs (PPLNS uses
 * `zRemRangeByRank` to slide its window; Group-Solo uses `zRem`
 * + key-by-key `del`; both touch hashes via `hSet/hGet/hGetAll`).
 *
 * The internal Maps are exposed as `_store` / `_zsets` / `_hashes`
 * so tests can assert raw state without round-tripping through the
 * fake's public API.
 */
export function createMockRedis() {
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
        del: async (keyOrKeys: string | string[]) => {
            const ks = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            for (const k of ks) { store.delete(k); zsets.delete(k); hashes.delete(k); }
        },
        scan: async (_cursor: number, opts: { MATCH: string; COUNT?: number }) => {
            const pattern = opts.MATCH;
            const regex = new RegExp(
                '^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
            );
            const allKeys = [...store.keys(), ...zsets.keys(), ...hashes.keys()];
            return { cursor: 0, keys: Array.from(new Set(allKeys.filter(k => regex.test(k)))) };
        },
        expire: async (_key: string, _seconds?: number) => 1,
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
        zRem: async (key: string, value: string) => {
            const z = getZ(key);
            const idx = z.findIndex(e => e.value === value);
            if (idx >= 0) z.splice(idx, 1);
        },
        zRemRangeByRank: async (key: string, start: number, end: number) => {
            const z = getZ(key);
            const e = end === -1 ? z.length - 1 : end;
            z.splice(start, e - start + 1);
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

// ── In-memory TypeORM repository fake ─────────────────────────────

/**
 * Stand-in for `Repository<T>` covering the methods the regtest specs
 * exercise. `save` does a best-effort upsert by `id`, by composite
 * `(address, groupId)`, or by `address` alone — matching the unique
 * indexes that the real entities carry, so tests never end up with
 * accidental duplicates.
 */
export function createMockRepo<T>() {
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
    const repo: any = {
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
    return repo;
}
