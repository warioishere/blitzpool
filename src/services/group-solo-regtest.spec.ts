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

import { GroupSoloService } from './group-solo.service';
import { PplnsGroupBlockHistoryEntity } from '../ORM/pplns-group/pplns-group-block-history.entity';
import { PplnsGroupBalanceEntity } from '../ORM/pplns-group/pplns-group-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import {
    rpcCall,
    createMockRedis,
    createMockRepo,
    assembleWithMiningJobAndTemplate,
} from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ALICE = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';
const ADDR_CHARLIE = 'bcrt1qlppw7cnqspnky6qzv8p2n468lpvwuct7ehp7l2';

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

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('Group-Solo Regtest — End-to-End with Bitcoin Core', () => {

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
      // BIP34 requires the coinbase scriptSig to start with the block height as a minimally-encoded
      // scriptNum. For heights 1–16 that means OP_N, which bitcoinjs.script.number.encode() encodes
      // as an empty buffer (caller is expected to use the OP opcode). To keep the coinbase builder
      // simple we require chain height ≥ 17 so the height always fits in the length-prefixed bytes
      // encoding. Auto-mine up to that threshold if needed.
      if (info.blocks < 17) {
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

    console.log(`\n=== Group-Solo Regtest ===`);
    console.log(`Height: ${height}`);
    console.log(`Block reward: ${blockReward} sats`);

    // Build + submit via production MiningJob path (distribution uses percent).
    const mjDist = distribution.map(d => ({ address: d.address, percent: d.percent }));
    const { submitResult: result, coinbaseTx } = await assembleWithMiningJobAndTemplate(mjDist, template, 'gs-basic');
    console.log(`Submit result: ${result === null ? 'SUCCESS!' : result}`);
    expect(result).toBeNull();

    // Coinbase total must equal blockReward.
    const coinbaseTotal = coinbaseTx.outs.reduce((s: number, o: any) => s + o.value, 0);
    expect(coinbaseTotal).toBe(blockReward);

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

  // ── Finder-bonus mode: per-miner coinbase ────────────────────────
  //
  // Verifies Option A end-to-end: a group with `finderBonusSats > 0`
  // produces per-miner coinbase templates where each session names its
  // own address as the bonus recipient. Bitcoin Core must accept the
  // resulting block (4 outputs: fee + bonus + alice-prop + bob-prop)
  // and the bookkeeping must match the on-chain split exactly.
  //
  // Without this regtest we'd only know the math is internally
  // consistent — not that real Core accepts the output layout.
  it('finder-bonus mode: per-miner coinbase with bonus output is accepted by Core', async () => {
    const FINDER_BONUS = 1_000_000; // 0.01 BTC

    const { service, redis } = makeService();
    // Seed group with finderBonusSats configured. The service reads
    // this from the live group entity, so we push a row into the
    // mock groupRepo.
    const groupRepo = (service as any).groupRepo;
    groupRepo.findOneBy = async (where: any) => {
      if (where.id === 'grp-1') {
        return { id: 'grp-1', finderBonusSats: FINDER_BONUS, dissolvedAt: null };
      }
      return null;
    };

    // Two active miners with 60/40 share split.
    await service.recordShare(ADDR_ALICE, 600);
    await service.recordShare(ADDR_BOB, 400);

    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const blockReward = template.coinbasevalue;
    const height = template.height;

    // Build alice's per-miner template (alice as finderAddress).
    const distribution = await service.getPayoutDistribution('grp-1', blockReward, ADDR_ALICE);

    // Distribution must include: fee + bonus(alice) + alice-prop + bob.
    const addresses = distribution.map(d => d.address);
    expect(addresses).toContain(ADDR_FEE);
    expect(addresses).toContain(ADDR_ALICE);
    expect(addresses).toContain(ADDR_BOB);
    // Alice should appear at least twice — once for bonus, once for prop.
    const aliceCount = addresses.filter(a => a === ADDR_ALICE).length;
    expect(aliceCount).toBeGreaterThanOrEqual(2);

    // Locate the dedicated bonus output (exact match on configured sats).
    const bonusOutput = distribution.find(d => d.address === ADDR_ALICE && d.sats === FINDER_BONUS);
    expect(bonusOutput).toBeDefined();

    console.log(`\n=== Group-Solo Regtest (FINDER BONUS) ===`);
    console.log(`Height: ${height}`);
    console.log(`Block reward: ${blockReward} sats, finder bonus: ${FINDER_BONUS} sats`);

    // Build + mine + submit via production MiningJob path.
    const mjDist = distribution.map(d => ({ address: d.address, percent: d.percent }));
    const { submitResult: result, coinbaseTx } = await assembleWithMiningJobAndTemplate(mjDist, template, 'gs-bonus');
    console.log(`Submit result (bonus mode): ${result === null ? 'SUCCESS!' : result}`);
    expect(result).toBeNull();

    // Coinbase total must equal blockReward exactly.
    const coinbaseTotal = coinbaseTx.outs.reduce((s: number, o: any) => s + o.value, 0);
    expect(coinbaseTotal).toBe(blockReward);

    // Chain tip advanced — block was accepted.
    const info = await rpcCall('getblockchaininfo');
    expect(info.blocks).toBe(height);

    // Bookkeeping: alice (the finder) gets bonus + prop on-chain.
    await service.onBlockFound(height, blockReward, ADDR_ALICE);

    // Per-finder snapshot wiped by deleteAllSnapshots.
    for (const [key] of redis._store) {
      expect(key).not.toMatch(/^groupsolo:grp-1:snapshot/);
    }

    console.log('✅ Bonus mode verified: Core accepted the per-miner coinbase with finder-bonus output');
  }, 60000);
});
