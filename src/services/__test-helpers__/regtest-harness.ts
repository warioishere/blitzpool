/**
 * Shared scaffolding for the *-regtest.spec.ts suite.
 *
 * The regtest specs all sit on top of:
 *   - one shared bitcoind (run sequentially via --runInBand),
 *   - the same JSON-RPC client (`rpcCall`),
 *   - the same hand-rolled coinbase / block / nonce-grinder
 *     (`buildCoinbase` / `buildBlock` / `mineBlock`), and
 *   - in-memory fakes for the Redis client and TypeORM repos that
 *     each suite was previously copying line-for-line.
 *
 * The fakes here are SUPERSETS — every method any single spec used
 * is available — so individual specs can drop their local duplicates
 * without losing capability.
 */
import * as bitcoinjs from 'bitcoinjs-lib';
import * as http from 'http';

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

// ── Block / coinbase construction ─────────────────────────────────

/**
 * Build a regtest coinbase tx with the given payouts and the SegWit
 * witness-commitment OP_RETURN appended last. `marker` is a free-form
 * tag written to the coinbase script so it's easy to spot which spec
 * mined a given block when tailing bitcoind logs.
 */
export function buildCoinbase(
    payouts: { address: string; sats: number }[],
    height: number,
    witnessCommit: Buffer,
    marker: string = 'blitzpool-regtest',
): bitcoinjs.Transaction {
    const tx = new bitcoinjs.Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    const heightEncoded = bitcoinjs.script.number.encode(height);
    tx.ins[0].script = Buffer.concat([
        Buffer.from([heightEncoded.length]),
        heightEncoded,
        Buffer.from(marker),
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

/** Wire a coinbase + extra txs into a block header derived from `template`. */
export function buildBlock(
    template: any,
    coinbaseTx: bitcoinjs.Transaction,
    transactions: bitcoinjs.Transaction[] = [],
): bitcoinjs.Block {
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
