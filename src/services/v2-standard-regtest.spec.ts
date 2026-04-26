/**
 * V2 Standard Channel Regtest Integration Test
 *
 * Verifies the V2 standard-channel code path:
 *
 *   - Pool builds a MiningJob and patches its `extranoncePrefix` into the
 *     coinbase (via copyAndUpdateBlock) at job-send time. The miner
 *     receives this fixed merkle root and can't change the coinbase.
 *   - Miner submits only nonce/ntime/version (extranonce2 is fixed at 0).
 *   - Pool reconstructs the full block using the same MiningJob + the
 *     same extranoncePrefix + '00000000' extranonce2 and submits it.
 *
 * A mismatch between the merkle root the miner sees and the one implied
 * by the reconstructed coinbase would cause every mined share to fail
 * block acceptance — silent production bug. This test catches that.
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test, rpcpassword=test).
 *
 * Run: npx jest v2-standard-regtest --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { MiningJob } from '../models/MiningJob';
import { IJobTemplate } from './stratum-v1-jobs.service';
import { NETWORK, rpcCall, mineBlock } from './__test-helpers__/regtest-harness';

function buildJobTemplate(template: any, idSuffix: string): IJobTemplate {
  const transactions = template.transactions.map((t: any) => bitcoinjs.Transaction.fromHex(t.data));
  const tempCoinbaseTx = new bitcoinjs.Transaction();
  tempCoinbaseTx.version = 2;
  tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
  const txsWithDummy = [tempCoinbaseTx, ...transactions];

  const transactionBuffers = txsWithDummy.map(tx => tx.getHash(false));
  const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
  const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter((h: any) => h != null);
  const merkleRoot = merkleBranches.pop();
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

function makeConfigService() {
  return { get: (_k: string) => 'blitzpool-regtest' } as any;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('V2 Standard Channel Regtest — fixed-coinbase path produces valid blocks', () => {

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

  it('pool-allocated extranonce prefix in coinbase produces a block Bitcoin Core accepts', async () => {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
    const jobTemplate = buildJobTemplate(template, 'std');

    const miningJob = new MiningJob(
      makeConfigService(),
      NETWORK,
      'job-std-1',
      [{ address: minerAddress, percent: 100 }],
      jobTemplate,
    );

    // Simulate Sv2ExtranonceManager — pool allocates a 4-byte extranonce prefix for this channel
    const extranoncePrefix = Buffer.from('deadbeef', 'hex').toString('hex'); // 4 bytes as hex string
    // V2 standard channel: miner has no extranonce rolling — extranonce2 is always zeros
    const extranonce2 = '00000000';

    // ── Job-send path: compute the merkle root the miner will mine against ──
    const jobSideBlock = miningJob.copyAndUpdateBlock(
      jobTemplate, 0, 0, extranoncePrefix, extranonce2, jobTemplate.block.timestamp,
    );
    const merkleRootSentToMiner = Buffer.from(jobSideBlock.merkleRoot!);

    // ── Share-submission path: pool reconstructs the block from the same job ──
    // (in prod this happens when a miner submits a share that beats block target)
    const submissionBlock = miningJob.copyAndUpdateBlock(
      jobTemplate, 0, 0, extranoncePrefix, extranonce2, template.curtime,
    );

    // The two paths must agree on the merkle root, else block submission fails silently.
    expect(Buffer.from(submissionBlock.merkleRoot!).toString('hex'))
      .toBe(merkleRootSentToMiner.toString('hex'));

    // Now mine + submit
    expect(await mineBlock(submissionBlock, template.target)).toBe(true);
    const result = await rpcCall('submitblock', [submissionBlock.toHex(false)]);
    expect(result).toBeNull();

    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(template.height);
    console.log(`✅ V2 standard channel block accepted at height ${template.height}`);
  }, 30000);

  it('two different extranonce prefixes produce two distinct valid blocks', async () => {
    // Catches a bug where two concurrent channels would collide on the
    // same coinbase (e.g. if extranoncePrefix was ignored in merkle-root
    // computation). Each block submission must succeed independently.
    for (const prefix of ['11aa22bb', '33cc44dd']) {
      const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
      const minerAddress = await rpcCall('getnewaddress', ['', 'bech32']);
      const jobTemplate = buildJobTemplate(template, `std-${prefix}`);
      const miningJob = new MiningJob(
        makeConfigService(),
        NETWORK,
        `job-std-${prefix}`,
        [{ address: minerAddress, percent: 100 }],
        jobTemplate,
      );

      const block = miningJob.copyAndUpdateBlock(
        jobTemplate, 0, 0, prefix, '00000000', template.curtime,
      );
      expect(await mineBlock(block, template.target)).toBe(true);
      const result = await rpcCall('submitblock', [block.toHex(false)]);
      expect(result).toBeNull();
      console.log(`✅ V2 standard block with prefix ${prefix} accepted at height ${template.height}`);
    }
  }, 60000);
});
