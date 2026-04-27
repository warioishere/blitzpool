/**
 * V2 Extended Channel Regtest Integration Test
 *
 * Verifies that the SV2 extended-channel coinbase reconstruction path
 * produces blocks Bitcoin Core accepts.
 *
 * Flow tested (matches production):
 *   1. Pool builds a MiningJob with an 8-byte extranonce placeholder
 *   2. Pool sends the miner `coinbasePrefix` + `coinbaseSuffix` (split)
 *   3. Miner picks their extranonce bytes (extranonce_prefix + miner_extranonce)
 *   4. Pool reconstructs the full coinbase by slotting the real extranonce in
 *   5. For non-8-byte extranonces, the scriptSig length varint at offset 41 is patched
 *   6. Block is built with the reconstructed coinbase and submitted
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test, rpcpassword=test).
 *
 * Run: npx jest v2-extended-regtest --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import { MiningJob } from '../models/MiningJob';
import { NETWORK, rpcCall, mineBlock, buildJobTemplate, makeConfigService } from './__test-helpers__/regtest-harness';
import { patchCoinbasePrefixVarint } from '../utils/coinbase-prefix.utils';

/**
 * End-to-end extended-channel block build + submit.
 *
 * @param extranoncePrefix  Pool-allocated prefix (simulates Sv2ExtranonceManager.allocate)
 * @param minerExtranonce   Miner-rollable portion
 */
async function runExtendedRound(extranoncePrefix: Buffer, minerExtranonce: Buffer, label: string): Promise<number> {
  const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
  const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
  const jobTemplate = buildJobTemplate(template, label);

  const miningJob = new MiningJob(
    makeConfigService(),
    NETWORK,
    `job-${label}`,
    [{ address: minerAddress, percent: 100 }],
    jobTemplate,
  );

  const totalExtranonceSize = extranoncePrefix.length + minerExtranonce.length;
  const patchedPrefix = patchCoinbasePrefixVarint(miningJob.getCoinbasePrefixBuffer(), totalExtranonceSize);
  const coinbaseSuffix = miningJob.getCoinbaseSuffixBuffer();

  // Reconstruct coinbase from prefix + extranoncePrefix + minerExtranonce + suffix
  // (this is what the pool does when a miner submits a winning extended share)
  const fullCoinbaseBytes = Buffer.concat([patchedPrefix, extranoncePrefix, minerExtranonce, coinbaseSuffix]);
  // Parse back into a Transaction so we can add the witness for block assembly
  const coinbaseTx = bitcoinjs.Transaction.fromBuffer(fullCoinbaseBytes);
  coinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];

  // Assemble block
  const block = new bitcoinjs.Block();
  block.version = template.version;
  block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
  block.timestamp = template.curtime;
  block.bits = parseInt(template.bits, 16);
  block.transactions = [coinbaseTx, ...jobTemplate.block.transactions.slice(1)];
  block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);

  expect(await mineBlock(block, template.target)).toBe(true);
  const result = await rpcCall('submitblock', [block.toHex(false)]);
  expect(result).toBeNull();
  return template.height;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('V2 Extended Channel Regtest — coinbase reconstruction produces valid blocks', () => {

  beforeAll(async () => {
    try {
      const info = await rpcCall('getblockchaininfo');
      expect(info.chain).toBe('regtest');
      // Force single-wallet state — unscoped wallet RPCs are ambiguous if a
      // stale wallet from a prior session is still attached.
      const wallets: string[] = await rpcCall('listwallets');
      for (const name of wallets) {
        if (name !== 'default') {
          try { await rpcCall('unloadwallet', [name]); } catch { /* ignore */ }
        }
      }
      if (!wallets.includes('default')) {
        try { await rpcCall('createwallet', ['default']); } catch { /* already exists */ }
      }
      if (info.blocks < 17) {
        const addr = await rpcCall('getnewaddress');
        await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
      }
    } catch {
      throw new Error('Bitcoin Core regtest not running at localhost:18443. Start with: bitcoind -regtest -daemon -rpcuser=test -rpcpassword=test -rpcport=18443');
    }
  });

  it('default 8-byte extranonce (4+4) reconstruction is accepted', async () => {
    const extranoncePrefix = Buffer.from('aabbccdd', 'hex');     // 4 bytes
    const minerExtranonce = Buffer.from('11223344', 'hex');      // 4 bytes
    const height = await runExtendedRound(extranoncePrefix, minerExtranonce, 'ext8');
    console.log(`✅ V2 extended 8-byte extranonce accepted at height ${height}`);
  }, 30000);

  it('10-byte extranonce (4+6) triggers varint patch and is accepted', async () => {
    const extranoncePrefix = Buffer.from('aabbccdd', 'hex');     // 4 bytes
    const minerExtranonce = Buffer.from('112233445566', 'hex');  // 6 bytes
    const height = await runExtendedRound(extranoncePrefix, minerExtranonce, 'ext10');
    console.log(`✅ V2 extended 10-byte extranonce accepted at height ${height}`);
  }, 30000);

  it('12-byte extranonce (4+8) triggers varint patch and is accepted', async () => {
    const extranoncePrefix = Buffer.from('aabbccdd', 'hex');         // 4 bytes
    const minerExtranonce = Buffer.from('1122334455667788', 'hex');  // 8 bytes
    const height = await runExtendedRound(extranoncePrefix, minerExtranonce, 'ext12');
    console.log(`✅ V2 extended 12-byte extranonce accepted at height ${height}`);
  }, 30000);

  it('walking jobTemplate.merkle_branch from a real coinbase txid matches bitcoinjs.Block.calculateMerkleRoot', async () => {
    // Closes the gap where this spec rebuilt the merkle root via
    // `bitcoinjs.Block.calculateMerkleRoot(transactions, false)` instead of
    // walking the path Production walks (`StratumV2Client.ts:1372-1378`,
    // walking `extJob.merklePath`). If `jobTemplate.merkle_branch` were ever
    // mis-extracted (wrong slice index, missing pop, mis-ordered siblings),
    // the production block header would carry a different merkleRoot than
    // bitcoinjs would compute from the transactions list — Bitcoin Core
    // would silently reject every winning extended share.
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
    const jobTemplate = buildJobTemplate(template, 'mpathcheck');
    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-mpathcheck',
      [{ address: minerAddress, percent: 100 }],
      jobTemplate,
    );

    // Build the real (non-witness) coinbase bytes — same path Production
    // hashes for share validation.
    const realCoinbaseBytes = Buffer.concat([
      miningJob.getCoinbasePrefixBuffer(),
      Buffer.alloc(8, 0),                     // 8-byte extranonce slot, filled with zeros
      miningJob.getCoinbaseSuffixBuffer(),
    ]);
    const coinbaseTxid = bitcoinjs.crypto.hash256(realCoinbaseBytes);

    // Path A — walk jobTemplate.merkle_branch (what Production does on a winning share)
    let walkedRoot = Buffer.from(coinbaseTxid);
    const both = Buffer.alloc(64);
    for (const sibHex of jobTemplate.merkle_branch) {
      both.set(walkedRoot, 0);
      both.set(Buffer.from(sibHex, 'hex'), 32);
      walkedRoot = bitcoinjs.crypto.hash256(both);
    }

    // Path B — let bitcoinjs rebuild the full merkle tree from the
    // transactions list (with the real coinbase swapped in)
    const realCoinbaseTx = bitcoinjs.Transaction.fromBuffer(realCoinbaseBytes);
    realCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
    const txsForRebuild = [realCoinbaseTx, ...jobTemplate.block.transactions.slice(1)];
    const rebuiltRoot = bitcoinjs.Block.calculateMerkleRoot(txsForRebuild, false);

    expect(walkedRoot.toString('hex')).toBe(rebuiltRoot.toString('hex'));
    console.log(`✅ jobTemplate.merkle_branch walk matches full-tree merkleRoot (root=${walkedRoot.toString('hex').slice(0, 16)}…)`);
  }, 30000);

  it('share-validation txid matches block-reconstruction txid (no merkle mismatch)', async () => {
    // This is the invariant that, if broken, would cause every extended share to
    // fail block acceptance even though the miner's share looks valid to the pool.
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
    const jobTemplate = buildJobTemplate(template, 'txidcheck');
    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-txidcheck',
      [{ address: minerAddress, percent: 100 }],
      jobTemplate,
    );

    const extranoncePrefix = Buffer.alloc(4, 0xaa);
    const minerExtranonce = Buffer.alloc(6, 0xbb);
    const totalExtranonceSize = 10;

    const patchedPrefix = patchCoinbasePrefixVarint(miningJob.getCoinbasePrefixBuffer(), totalExtranonceSize);
    const coinbaseSuffix = miningJob.getCoinbaseSuffixBuffer();

    // Path 1: share-validation txid = hash256(prefix + extranonce + suffix)
    const rawBytes = Buffer.concat([patchedPrefix, extranoncePrefix, minerExtranonce, coinbaseSuffix]);
    const shareTxid = bitcoinjs.crypto.hash256(rawBytes);

    // Path 2: parse bytes into a Transaction, call getHash(false)
    const coinbaseTx = bitcoinjs.Transaction.fromBuffer(rawBytes);
    const blockTxid = coinbaseTx.getHash(false);

    expect(shareTxid.toString('hex')).toBe(blockTxid.toString('hex'));
    console.log(`✅ Share-validation and block-reconstruction txids match`);
  }, 30000);
});
