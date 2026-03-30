/**
 * PPLNS Regtest Integration Test
 *
 * Tests that Bitcoin Core 29.0 accepts a block with a multi-output
 * PPLNS coinbase transaction. Requires a running regtest node at
 * localhost:18443 (rpcuser=test, rpcpassword=test).
 *
 * Run: npx jest pplns-regtest --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as http from 'http';

const RPC_URL = 'http://127.0.0.1:18443';
const RPC_USER = 'test';
const RPC_PASS = 'test';
const NETWORK = bitcoinjs.networks.regtest;

// Regtest addresses from wallet
const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_MINER1 = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_MINER2 = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';
const ADDR_MINER3 = 'bcrt1qlppw7cnqspnky6qzv8p2n468lpvwuct7ehp7l2';

// ── RPC Helper ──────────────────────────────────────────────────

function rpcCall(method: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');

    const req = http.request(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
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

// ── Block Builder ───────────────────────────────────────────────

function buildPplnsCoinbase(
  payouts: { address: string; sats: number }[],
  height: number,
  witnessCommit: Buffer,
): bitcoinjs.Transaction {
  const tx = new bitcoinjs.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

  // BIP34: block height in coinbase script
  const heightEncoded = bitcoinjs.script.number.encode(height);
  tx.ins[0].script = Buffer.concat([
    Buffer.from([heightEncoded.length]),
    heightEncoded,
    Buffer.from('blitzpool-pplns-test'),
    Buffer.alloc(4, 0), // padding for extranonce
  ]);

  // Witness reserved value
  tx.ins[0].witness = [Buffer.alloc(32, 0)];

  // PPLNS payout outputs
  for (const payout of payouts) {
    const script = bitcoinjs.address.toOutputScript(payout.address, NETWORK);
    tx.addOutput(script, payout.sats);
  }

  // SegWit commitment (OP_RETURN)
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

function buildBlock(
  template: any,
  coinbaseTx: bitcoinjs.Transaction,
  transactions: bitcoinjs.Transaction[],
): bitcoinjs.Block {
  const block = new bitcoinjs.Block();
  block.version = template.version;
  block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
  block.timestamp = template.curtime;
  block.bits = parseInt(template.bits, 16);
  block.nonce = 0;
  block.transactions = [coinbaseTx, ...transactions];

  // Calculate merkle root
  block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);

  return block;
}

function mineBlock(block: bitcoinjs.Block, targetHex: string): boolean {
  const target = Buffer.from(targetHex.padStart(64, '0'), 'hex');

  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    block.nonce = nonce;
    const hash = bitcoinjs.crypto.hash256(block.toBuffer(true));
    // Compare as big-endian (reverse the LE hash)
    const hashReversed = Buffer.from(hash).reverse();
    if (hashReversed.compare(target) <= 0) {
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('PPLNS Regtest — Bitcoin Core Block Submission', () => {

  beforeAll(async () => {
    // Verify regtest is running
    try {
      const info = await rpcCall('getblockchaininfo');
      expect(info.chain).toBe('regtest');
    } catch {
      throw new Error('Bitcoin Core regtest not running at localhost:18443. Start with: bitcoind -regtest -daemon -rpcuser=test -rpcpassword=test -rpcport=18443');
    }
  });

  it('should accept a block with 4 PPLNS coinbase outputs (fee + 3 miners)', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);

    const blockReward = template.coinbasevalue; // sats
    const height = template.height;

    // PPLNS distribution: 2% fee, 50/30/20 split for miners
    const feeSats = Math.floor(blockReward * 0.02);
    const miner1Sats = Math.floor(blockReward * 0.49);
    const miner2Sats = Math.floor(blockReward * 0.29);
    const miner3Sats = blockReward - feeSats - miner1Sats - miner2Sats; // remainder

    const payouts = [
      { address: ADDR_FEE, sats: feeSats },
      { address: ADDR_MINER1, sats: miner1Sats },
      { address: ADDR_MINER2, sats: miner2Sats },
      { address: ADDR_MINER3, sats: miner3Sats },
    ];

    console.log(`\n=== PPLNS Regtest Block Test ===`);
    console.log(`Height: ${height}`);
    console.log(`Block reward: ${blockReward} sats`);
    payouts.forEach((p, i) => {
      console.log(`Output ${i}: ${p.sats} sats → ${p.address.substring(0, 20)}... (${(p.sats / blockReward * 100).toFixed(2)}%)`);
    });

    // Parse template transactions
    const txs = template.transactions.map((t: any) =>
      bitcoinjs.Transaction.fromHex(t.data),
    );

    // Calculate witness commitment
    const dummyCoinbase = new bitcoinjs.Transaction();
    dummyCoinbase.version = 2;
    dummyCoinbase.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    dummyCoinbase.addOutput(Buffer.alloc(22, 0), 0);
    dummyCoinbase.ins[0].witness = [Buffer.alloc(32, 0)];

    const allTxs = [dummyCoinbase, ...txs];
    const witnessCommit = bitcoinjs.Block.calculateMerkleRoot(allTxs, true);

    // Build coinbase with PPLNS outputs
    const coinbaseTx = buildPplnsCoinbase(payouts, height, witnessCommit);

    // Build and mine block
    const block = buildBlock(template, coinbaseTx, txs);
    const mined = mineBlock(block, template.target);
    expect(mined).toBe(true);

    const blockHex = block.toHex(false);
    console.log(`Block size: ${blockHex.length / 2} bytes`);
    console.log(`Block weight: ${block.weight()} WU`);
    console.log(`Coinbase outputs: ${coinbaseTx.outs.length} (${payouts.length} payouts + 1 OP_RETURN)`);

    // Submit to Bitcoin Core
    const result = await rpcCall('submitblock', [blockHex]);

    console.log(`Submit result: ${result === null ? 'SUCCESS!' : result}`);
    expect(result).toBeNull(); // null = accepted

    // Verify block was accepted
    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(height);

    // Verify coinbase outputs in the accepted block
    const blockHash = await rpcCall('getblockhash', [height]);
    const acceptedBlock = await rpcCall('getblock', [blockHash, 2]);
    const coinbase = acceptedBlock.tx[0];

    console.log(`\nAccepted coinbase txid: ${coinbase.txid}`);
    console.log(`Coinbase vout count: ${coinbase.vout.length}`);

    // Should have 5 outputs: fee + 3 miners + OP_RETURN
    expect(coinbase.vout.length).toBe(5);

    // Verify amounts match what we sent
    const voutValues = coinbase.vout.map((v: any) => Math.round(v.value * 1e8));
    expect(voutValues[0]).toBe(feeSats);
    expect(voutValues[1]).toBe(miner1Sats);
    expect(voutValues[2]).toBe(miner2Sats);
    expect(voutValues[3]).toBe(miner3Sats);
    expect(voutValues[4]).toBe(0); // OP_RETURN

    console.log('\n✅ Bitcoin Core accepted the PPLNS multi-output coinbase block!');
  }, 30000);

  it('should accept a block with 20 PPLNS outputs', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const blockReward = template.coinbasevalue;
    const height = template.height;

    // 20 miners with equal shares + fee
    const feeSats = Math.floor(blockReward * 0.02);
    const perMiner = Math.floor((blockReward - feeSats) / 20);

    const payouts: { address: string; sats: number }[] = [
      { address: ADDR_FEE, sats: feeSats },
    ];

    // Generate 20 miner addresses
    const minerAddresses: string[] = [];
    for (let i = 0; i < 20; i++) {
      const addr = await rpcCall('getnewaddress', ['', 'bech32']);
      minerAddresses.push(addr);
      payouts.push({ address: addr, sats: perMiner });
    }

    // Give remainder to last miner
    const totalAssigned = feeSats + perMiner * 20;
    payouts[payouts.length - 1].sats += blockReward - totalAssigned;

    // Verify total
    const total = payouts.reduce((s, p) => s + p.sats, 0);
    expect(total).toBe(blockReward);

    const txs = template.transactions.map((t: any) =>
      bitcoinjs.Transaction.fromHex(t.data),
    );

    const dummyCoinbase = new bitcoinjs.Transaction();
    dummyCoinbase.version = 2;
    dummyCoinbase.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    dummyCoinbase.addOutput(Buffer.alloc(22, 0), 0);
    dummyCoinbase.ins[0].witness = [Buffer.alloc(32, 0)];

    const witnessCommit = bitcoinjs.Block.calculateMerkleRoot([dummyCoinbase, ...txs], true);
    const coinbaseTx = buildPplnsCoinbase(payouts, height, witnessCommit);
    const block = buildBlock(template, coinbaseTx, txs);
    const mined = mineBlock(block, template.target);
    expect(mined).toBe(true);

    const result = await rpcCall('submitblock', [block.toHex(false)]);
    console.log(`\n20-output block submit: ${result === null ? 'SUCCESS!' : result}`);
    console.log(`Coinbase weight: ${coinbaseTx.weight()} WU`);
    expect(result).toBeNull();

    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(height);

    console.log('✅ Bitcoin Core accepted 20-output PPLNS coinbase!');
  }, 30000);
});
