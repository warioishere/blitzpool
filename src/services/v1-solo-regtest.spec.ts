/**
 * V1 Solo Regtest Integration Test
 *
 * Verifies that the V1 solo coinbase construction path produces blocks
 * Bitcoin Core accepts. Exercises the real `MiningJob` class:
 *
 *   - No-fee mode: single miner output, miner keeps 100% of the reward
 *   - With dev-fee mode: two outputs (pool fee + miner)
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test, rpcpassword=test).
 *
 * Run: npx jest v1-solo-regtest --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as http from 'http';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { MiningJob } from '../models/MiningJob';
import { IJobTemplate } from './stratum-v1-jobs.service';

const RPC_URL = 'http://127.0.0.1:18443';
const RPC_USER = 'test';
const RPC_PASS = 'test';
const NETWORK = bitcoinjs.networks.regtest;

// ── RPC helper ──────────────────────────────────────────────────

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

// ── Build IJobTemplate from bitcoind's getblocktemplate ─────────
// Replicates what StratumV1JobsService does so we can feed a MiningJob
// the exact shape of data it expects in production.

function buildJobTemplate(template: any, idSuffix: string): IJobTemplate {
  const transactions = template.transactions.map((t: any) => bitcoinjs.Transaction.fromHex(t.data));

  // Dummy coinbase to compute the merkle branch (real coinbase slots in later)
  const tempCoinbaseTx = new bitcoinjs.Transaction();
  tempCoinbaseTx.version = 2;
  tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
  const txsWithDummy = [tempCoinbaseTx, ...transactions];

  const transactionBuffers = txsWithDummy.map(tx => tx.getHash(false));
  const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
  const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter((h: any) => h != null);
  const merkleRoot = merkleBranches.pop();
  // Strip the first (coinbase) and the now-popped root; what remains is the merkle branch
  const merkle_branch = merkleBranches.slice(1).map(b => b.toString('hex'));

  const block = new bitcoinjs.Block();
  block.version = template.version;
  block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
  block.timestamp = template.curtime;
  block.bits = parseInt(template.bits, 16);
  block.merkleRoot = merkleRoot!;
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

function makeConfigService(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    POOL_IDENTIFIER: 'blitzpool-regtest',
    ...overrides,
  };
  return { get: (key: string) => env[key] } as any;
}

async function mineBlock(block: bitcoinjs.Block, targetHex: string): Promise<boolean> {
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

describe('V1 Solo Regtest — MiningJob produces blocks Bitcoin Core accepts', () => {

  beforeAll(async () => {
    try {
      const info = await rpcCall('getblockchaininfo');
      expect(info.chain).toBe('regtest');
      // Bump chain past BIP34 small-height ambiguity (OP_N encoding for heights ≤ 16)
      if (info.blocks < 17) {
        try { await rpcCall('createwallet', ['default']); } catch { /* already exists */ }
        const addr = await rpcCall('getnewaddress');
        await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
      }
    } catch {
      throw new Error('Bitcoin Core regtest not running at localhost:18443. Start with: bitcoind -regtest -daemon -rpcuser=test -rpcpassword=test -rpcport=18443');
    }
  });

  it('single-output coinbase (noFee: miner keeps 100%) is accepted', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);

    const jobTemplate = buildJobTemplate(template, 'nofee');
    const payoutInformation = [{ address: minerAddress, percent: 100 }];

    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-1',
      payoutInformation,
      jobTemplate,
    );

    // Assemble the block — copyAndUpdateBlock slots our coinbase into the template
    // and recomputes the merkle root.
    const block = miningJob.copyAndUpdateBlock(
      jobTemplate, 0, 0, '00000000', '00000000',
      template.curtime,
    );

    const coinbase = miningJob.cloneCoinbaseTransaction();
    // One miner output + the OP_RETURN witness commitment = 2 total
    expect(coinbase.outs.length).toBe(2);
    expect(coinbase.outs[0].value).toBe(template.coinbasevalue);

    expect(await mineBlock(block, template.target)).toBe(true);
    const result = await rpcCall('submitblock', [block.toHex(false)]);
    expect(result).toBeNull();

    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(template.height);
    console.log(`✅ V1 single-output coinbase accepted at height ${template.height}`);
  }, 30000);

  it('two-output coinbase (pool fee + miner) is accepted', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
    const feeAddress = await rpcCall('getnewaddress', ['', 'bech32']);

    const jobTemplate = buildJobTemplate(template, 'fee');
    const feePercent = 1.5;
    const payoutInformation = [
      { address: feeAddress, percent: feePercent },
      { address: minerAddress, percent: 100 - feePercent },
    ];

    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-2',
      payoutInformation,
      jobTemplate,
    );

    const block = miningJob.copyAndUpdateBlock(
      jobTemplate, 0, 0, '00000000', '00000000',
      template.curtime,
    );

    const coinbase = miningJob.cloneCoinbaseTransaction();
    // fee + miner + OP_RETURN witness commitment
    expect(coinbase.outs.length).toBe(3);
    // Total sat value matches reward (floor rounding remainder sits in first output)
    const totalOut = coinbase.outs.reduce((s, o) => s + o.value, 0);
    expect(totalOut).toBe(template.coinbasevalue);

    const expectedFeeSats = Math.floor((feePercent / 100) * template.coinbasevalue);
    const expectedMinerSats = Math.floor(((100 - feePercent) / 100) * template.coinbasevalue);
    // First output carries the remainder per `createCoinbaseTransaction`
    const remainder = template.coinbasevalue - expectedFeeSats - expectedMinerSats;
    expect(coinbase.outs[0].value).toBe(expectedFeeSats + remainder);
    expect(coinbase.outs[1].value).toBe(expectedMinerSats);

    expect(await mineBlock(block, template.target)).toBe(true);
    const result = await rpcCall('submitblock', [block.toHex(false)]);
    expect(result).toBeNull();

    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(template.height);
    console.log(`✅ V1 fee+miner coinbase accepted at height ${template.height}`);
  }, 30000);

  it('prefix/suffix split round-trips: reconstructing from parts matches original coinbase', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);

    const jobTemplate = buildJobTemplate(template, 'split');
    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-3',
      [{ address: minerAddress, percent: 100 }],
      jobTemplate,
    );

    const prefix = miningJob.getCoinbasePrefixBuffer();
    const suffix = miningJob.getCoinbaseSuffixBuffer();
    const extranonce = Buffer.alloc(8, 0); // V1 slot: extranonce1 (4 bytes) + extranonce2 (4 bytes)

    // Reconstruct the non-witness coinbase from prefix + extranonce + suffix
    const reconstructed = Buffer.concat([prefix, extranonce, suffix]);
    // Original non-witness hex (without witness data)
    const original = miningJob.getCoinbaseTxHex();

    expect(reconstructed.toString('hex')).toBe(original);
    console.log(`✅ V1 coinbase prefix/suffix round-trip verified`);
  }, 30000);
});
