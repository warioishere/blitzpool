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

import { MiningJob } from '../models/MiningJob';
import { NETWORK, rpcCall, mineBlock, buildJobTemplate, makeConfigService } from './__test-helpers__/regtest-harness';

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('V1 Solo Regtest — MiningJob produces blocks Bitcoin Core accepts', () => {

  beforeAll(async () => {
    try {
      const info = await rpcCall('getblockchaininfo');
      expect(info.chain).toBe('regtest');
      // Unscoped wallet RPCs (getnewaddress, generatetoaddress, …) fail with
      // "Multiple wallets are loaded" if a stale wallet from a prior session is
      // still attached. Force the node into a single-wallet state.
      const wallets: string[] = await rpcCall('listwallets');
      for (const name of wallets) {
        if (name !== 'default') {
          try { await rpcCall('unloadwallet', [name]); } catch { /* ignore */ }
        }
      }
      if (!wallets.includes('default')) {
        try { await rpcCall('createwallet', ['default']); } catch { /* already exists */ }
      }
      // Bump chain past BIP34 small-height ambiguity (OP_N encoding for heights ≤ 16)
      if (info.blocks < 17) {
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
    const extranonce = Buffer.alloc(12, 0); // V1 slot: extranonce1 (4 bytes) + extranonce2 (8 bytes)

    // Reconstruct the non-witness coinbase from prefix + extranonce + suffix
    const reconstructed = Buffer.concat([prefix, extranonce, suffix]);
    // Original non-witness hex (without witness data)
    const original = miningJob.getCoinbaseTxHex();

    expect(reconstructed.toString('hex')).toBe(original);
    console.log(`✅ V1 coinbase prefix/suffix round-trip verified`);
  }, 30000);

  it('coinbase with all 5 supported address types (P2PKH/P2SH/P2WPKH/P2WSH/P2TR) is accepted', async () => {
    // Closes the coverage gap where only P2WPKH was end-to-end-validated.
    // Each branch of MiningJob.getPaymentScript is exercised in a single
    // coinbase that Bitcoin Core then validates byte-for-byte.
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);

    // Native types straight from bitcoind
    const p2pkhAddr  = await rpcCall('getnewaddress', ['', 'legacy']);
    const p2shAddr   = await rpcCall('getnewaddress', ['', 'p2sh-segwit']);
    const p2wpkhAddr = await rpcCall('getnewaddress', ['', 'bech32']);
    const p2trAddr   = await rpcCall('getnewaddress', ['', 'bech32m']);

    // P2WSH: derive bitcoinjs-side from a real pubkey wrapped in a P2WPKH script.
    // Coinbase outputs accept any well-formed scriptPubKey — the script doesn't
    // need to be spendable by the wallet for block validity.
    const seedAddr = await rpcCall('getnewaddress', ['', 'bech32']);
    const seedInfo = await rpcCall('getaddressinfo', [seedAddr]);
    const pubkey = Buffer.from(seedInfo.pubkey, 'hex');
    const innerP2wpkh = bitcoinjs.payments.p2wpkh({ pubkey, network: NETWORK });
    const p2wshPayment = bitcoinjs.payments.p2wsh({
      redeem: { output: innerP2wpkh.output, network: NETWORK },
      network: NETWORK,
    });
    const p2wshAddr = p2wshPayment.address!;

    // 5 outputs × 20 % each. createCoinbaseTransaction puts the floor-rounding
    // remainder in outs[0] (P2PKH here).
    const payoutInformation = [
      { address: p2pkhAddr,  percent: 20 },
      { address: p2shAddr,   percent: 20 },
      { address: p2wpkhAddr, percent: 20 },
      { address: p2wshAddr,  percent: 20 },
      { address: p2trAddr,   percent: 20 },
    ];

    const jobTemplate = buildJobTemplate(template, 'all5');
    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-all5',
      payoutInformation,
      jobTemplate,
    );

    const block = miningJob.copyAndUpdateBlock(
      jobTemplate, 0, 0, '00000000', '00000000', template.curtime,
    );

    const coinbase = miningJob.cloneCoinbaseTransaction();
    // 5 payout outs + OP_RETURN witness commitment = 6 total
    expect(coinbase.outs.length).toBe(6);
    const totalOut = coinbase.outs.slice(0, 5).reduce((s, o) => s + o.value, 0);
    expect(totalOut).toBe(template.coinbasevalue);

    // Sanity-check each output script type by decoding it back to an address.
    // Catches a buggy MiningJob.getPaymentScript branch that emits the wrong
    // script class (e.g. p2tr branch returning p2wpkh bytes).
    expect(bitcoinjs.address.fromOutputScript(coinbase.outs[0].script, NETWORK)).toBe(p2pkhAddr);
    expect(bitcoinjs.address.fromOutputScript(coinbase.outs[1].script, NETWORK)).toBe(p2shAddr);
    expect(bitcoinjs.address.fromOutputScript(coinbase.outs[2].script, NETWORK)).toBe(p2wpkhAddr);
    expect(bitcoinjs.address.fromOutputScript(coinbase.outs[3].script, NETWORK)).toBe(p2wshAddr);
    expect(bitcoinjs.address.fromOutputScript(coinbase.outs[4].script, NETWORK)).toBe(p2trAddr);

    expect(await mineBlock(block, template.target)).toBe(true);
    const result = await rpcCall('submitblock', [block.toHex(false)]);
    expect(result).toBeNull();

    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(template.height);
    console.log(`✅ V1 coinbase with all 5 address types accepted at height ${template.height}`);
  }, 30000);
});
