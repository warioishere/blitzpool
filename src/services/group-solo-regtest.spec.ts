/**
 * Group-Solo Regtest Integration Test
 *
 * Tests end-to-end flow: GroupSoloService computes a real distribution from
 * recorded shares, builds a multi-output coinbase from that distribution, and
 * Bitcoin Core accepts the block. Also verifies that onBlockFound resets the
 * round (Redis keys cleared).
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test, rpcpassword=test).
 *
 * Run: npx jest group-solo-regtest --no-coverage
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

// ── RPC Helper ──────────────────────────────────────────────────

function rpcCall(method: string, params: any[] = []): Promise<any> {
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
          if (parsed.error) reject(new Error(`RPC error: ${JSON.stringify(parsed.error)}`));
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

// ── Mock stack for the service ──────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();
  const zsets = new Map<string, { score: number; value: string }[]>();
  const hashes = new Map<string, Map<string, string>>();
  const getZ = (key: string) => {
    if (!zsets.has(key)) zsets.set(key, []);
    return zsets.get(key)!;
  };
  return {
    incr: async (key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, val.toString());
      return val;
    },
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); },
    del: async (key: string) => { store.delete(key); zsets.delete(key); },
    incrByFloat: async (key: string, amount: number) => {
      const val = parseFloat(store.get(key) ?? '0') + amount;
      store.set(key, val.toString());
      return val;
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
    hSet: async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
    },
    hGet: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    hDel: async (key: string, field: string) => { hashes.get(key)?.delete(field); },
    hGetAll: async (key: string) => {
      const h = hashes.get(key);
      return h ? Object.fromEntries(h.entries()) : {};
    },
    hIncrByFloat: async (key: string, field: string, amount: number) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key)!;
      const val = parseFloat(h.get(field) ?? '0') + amount;
      h.set(field, val.toString());
      return val;
    },
    expire: async (_key: string, _seconds: number) => 1,
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
    find: async (q?: any) => {
      if (!q?.where) return [...rows];
      return (rows as any[]).filter(r =>
        Object.entries(q.where).every(([k, v]) => {
          if (v && typeof v === 'object' && Array.isArray((v as any)._value)) {
            return new Set((v as any)._value).has(r[k]);
          }
          return r[k] === v;
        }),
      );
    },
    findOneBy: async (where: any) =>
      (rows as any[]).find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    update: async (where: any, patch: any) => {
      for (const row of rows as any[]) {
        if (Object.entries(where).every(([k, v]) => row[k] === v)) Object.assign(row, patch);
      }
      return { affected: 0 } as any;
    },
    _rows: rows,
  };
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
  addressToGroup.set(ADDR_CHARLIE, { groupId: 'grp-1', active: true });

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
  return { service, redis };
}

// ── Block Builder ───────────────────────────────────────────────

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
    Buffer.from('blitzpool-group-solo-test'),
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

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('Group-Solo Regtest — End-to-End with Bitcoin Core', () => {

  beforeAll(async () => {
    try {
      const info = await rpcCall('getblockchaininfo');
      expect(info.chain).toBe('regtest');
      // BIP34 requires the coinbase scriptSig to start with the block height as a minimally-encoded
      // scriptNum. For heights 1–16 that means OP_N, which bitcoinjs.script.number.encode() encodes
      // as an empty buffer (caller is expected to use the OP opcode). To keep the coinbase builder
      // simple we require chain height ≥ 17 so the height always fits in the length-prefixed bytes
      // encoding. Auto-mine up to that threshold if needed.
      if (info.blocks < 17) {
        try { await rpcCall('createwallet', ['default']); } catch { /* already exists */ }
        const addr = await rpcCall('getnewaddress');
        await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
      }
    } catch {
      throw new Error('Bitcoin Core regtest not running at localhost:18443. Start with: bitcoind -regtest -daemon -rpcuser=test -rpcpassword=test -rpcport=18443');
    }
  });

  it('records shares, builds coinbase from real distribution, submits block, and resets round', async () => {
    const { service, redis } = makeService();

    // Simulate mining: Alice & Bob submit shares, Charlie hasn't yet
    await service.recordShare(ADDR_ALICE, 600);
    await service.recordShare(ADDR_BOB, 400);

    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const blockReward = template.coinbasevalue;
    const height = template.height;

    // Build distribution from the *service*, not hardcoded
    const distribution = await service.getPayoutDistribution('grp-1', blockReward);

    // Distribution must include fee + Alice + Bob, NOT Charlie (no shares)
    const addresses = distribution.map(d => d.address);
    expect(addresses).toContain(ADDR_FEE);
    expect(addresses).toContain(ADDR_ALICE);
    expect(addresses).toContain(ADDR_BOB);
    expect(addresses).not.toContain(ADDR_CHARLIE);

    // Convert percent distribution to sat amounts for the coinbase
    const payouts = distribution.map(d => ({
      address: d.address,
      sats: Math.floor((d.percent / 100) * blockReward),
    }));
    // Fix rounding remainder → add to fee output
    const totalAssigned = payouts.reduce((s, p) => s + p.sats, 0);
    if (totalAssigned < blockReward) {
      payouts[0].sats += blockReward - totalAssigned;
    }

    console.log(`\n=== Group-Solo Regtest ===`);
    console.log(`Height: ${height}`);
    console.log(`Block reward: ${blockReward} sats`);
    console.log(`Distribution from service (${payouts.length} outputs):`);
    payouts.forEach((p, i) => {
      const label = p.address === ADDR_FEE ? 'FEE'
        : p.address === ADDR_ALICE ? 'ALICE (60% shares)'
        : p.address === ADDR_BOB ? 'BOB (40% shares)'
        : p.address.substring(0, 20);
      console.log(`  Output ${i}: ${p.sats} sats → ${label}`);
    });

    // Build + submit block
    const txs = template.transactions.map((t: any) => bitcoinjs.Transaction.fromHex(t.data));
    const dummyCoinbase = new bitcoinjs.Transaction();
    dummyCoinbase.version = 2;
    dummyCoinbase.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    dummyCoinbase.addOutput(Buffer.alloc(22, 0), 0);
    dummyCoinbase.ins[0].witness = [Buffer.alloc(32, 0)];
    const witnessCommit = bitcoinjs.Block.calculateMerkleRoot([dummyCoinbase, ...txs], true);

    const coinbaseTx = buildCoinbase(payouts, height, witnessCommit);
    const block = buildBlock(template, coinbaseTx, txs);
    const mined = mineBlock(block, template.target);
    expect(mined).toBe(true);

    const result = await rpcCall('submitblock', [block.toHex(false)]);
    console.log(`Submit result: ${result === null ? 'SUCCESS!' : result}`);
    expect(result).toBeNull();

    // Verify chain tip advanced
    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(height);

    // Now call the service's onBlockFound — should reset the round
    await service.onBlockFound(height, blockReward, ADDR_ALICE);

    // Round reset: no more group-1 Redis keys
    expect(redis._zsets.size).toBe(0);
    for (const [key] of redis._store) {
      expect(key).not.toMatch(/^groupsolo:grp-1:/);
    }

    // A fresh distribution call should now return the fee-only fallback.
    // Shape changed with the signed-ledger refactor: entries now carry a
    // `sats` field alongside percent/address.
    const freshDist = await service.getPayoutDistribution('grp-1', blockReward);
    expect(freshDist).toHaveLength(1);
    expect(freshDist[0].address).toBe(ADDR_FEE);
    expect(freshDist[0].percent).toBe(100);

    console.log('✅ End-to-end flow verified: shares → distribution → block submit → round reset');
  }, 60000);
});
