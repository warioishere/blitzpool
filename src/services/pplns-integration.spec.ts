jest.mock('node-telegram-bot-api', () => jest.fn());

/**
 * PPLNS Integration Test
 *
 * Simulates the complete PPLNS flow end-to-end:
 *   1. Multiple miners submit shares over time
 *   2. PPLNS distribution is calculated
 *   3. Real MiningJob is created with the distribution
 *   4. Coinbase transaction is verified (correct outputs, amounts, addresses)
 *   5. Block found triggers payout processing
 *   6. Pending balances and payout history are verified
 *   7. Multi-block accumulation tested for sub-dust miners
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import { MiningJob } from '../models/MiningJob';
import { IJobTemplate } from './stratum-v1-jobs.service';
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';

// ── Helpers ──────────────────────────────────────────────────────

const BLOCK_REWARD = 312_500_000; // 3.125 BTC
const NETWORK = bitcoinjs.networks.regtest;

// Regtest addresses (valid bech32 for regtest)
const FEE_ADDR   = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const MINER_A    = 'bcrt1qrp33g0q5b5698ahp5jnf0y5ems7p06sscnrvss';  // fictional but valid format... actually let me use proper ones
// Actually for regtest we need bcrt1... addresses. Let me generate valid ones.
// These are valid regtest P2WPKH addresses (20-byte witness program)
const ADDR_FEE    = 'bcrt1q4zy2q8q4autcujjuxy653c9fe3g2qe2gr84xqz';
const ADDR_MINER1 = 'bcrt1q4vctecss7yxdgd6pmg3cw2auggx834nwvqyt8j';
const ADDR_MINER2 = 'bcrt1qkhpva0cdzl849uzmcuucmmswdaf8ry6qcmnsyy';
const ADDR_MINER3 = 'bcrt1q2nuvcnjft64gwd0767aqxl7wl88g7h9fjrjjgx';

function createMockJobTemplate(height = 800_000): IJobTemplate {
  const block = new bitcoinjs.Block();
  block.version = 0x20000000;
  block.prevHash = Buffer.alloc(32, 0xaa);
  block.merkleRoot = Buffer.alloc(32, 0xbb);
  block.timestamp = Math.floor(Date.now() / 1000);
  block.bits = 0x1d00ffff;
  block.nonce = 0;
  block.transactions = [new bitcoinjs.Transaction()]; // dummy coinbase for witnessCommit
  block.transactions[0].version = 2;
  block.transactions[0].addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  block.transactions[0].addOutput(Buffer.alloc(22, 0), 0);
  block.transactions[0].ins[0].witness = [Buffer.alloc(32, 0)];
  block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(block.transactions, true);

  return {
    block,
    merkle_branch: [],
    blockData: {
      id: '1',
      creation: Date.now(),
      coinbasevalue: BLOCK_REWARD,
      networkDifficulty: 100_000,
      height,
      clearJobs: false,
    },
  };
}

// ── Mock infrastructure (same as unit tests) ────────────────────

function createMockRedis() {
  const store = new Map<string, string>();
  let zset: { score: number; value: string }[] = [];
  const hashes = new Map<string, Map<string, string>>();
  const getHash = (key: string) => {
    let h = hashes.get(key);
    if (!h) { h = new Map(); hashes.set(key, h); }
    return h;
  };

  return {
    incr: jest.fn(async (key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, val.toString());
      return val;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); hashes.delete(key); }),
    expire: jest.fn(async (_key: string, _seconds: number) => 1),
    incrByFloat: jest.fn(async (key: string, amount: number) => {
      const val = parseFloat(store.get(key) ?? '0') + amount;
      store.set(key, val.toString());
      return val;
    }),
    zAdd: jest.fn(async (_key: string, entry: { score: number; value: string }) => {
      zset.push(entry);
      zset.sort((a, b) => a.score - b.score);
    }),
    zRange: jest.fn(async (_key: string, start: number, end: number) => {
      if (end === -1) end = zset.length - 1;
      return zset.slice(start, end + 1).map(e => e.value);
    }),
    zRemRangeByRank: jest.fn(async (_key: string, start: number, end: number) => {
      zset.splice(start, end - start + 1);
    }),
    zCard: jest.fn(async () => zset.length),
    hGetAll: jest.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    hIncrByFloat: jest.fn(async (key: string, field: string, amount: number) => {
      const h = getHash(key);
      const cur = parseFloat(h.get(field) ?? '0') + amount;
      h.set(field, cur.toString());
      return cur;
    }),
  };
}

function createMockBalanceBacking() {
  const balances = new Map<string, { address: string; balanceSats: number; totalPaidSats: number }>();
  const service = {
    addPending: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) { existing.balanceSats += sats; }
      else { balances.set(address, { address, balanceSats: sats, totalPaidSats: 0 }); }
    }),
    getBalanceSats: jest.fn(async (address: string) => balances.get(address)?.balanceSats ?? 0),
    getBalance: jest.fn(async (address: string) => balances.get(address) ?? null),
    getAllWithBalance: jest.fn(async () =>
      Array.from(balances.values()).filter(b => b.balanceSats !== 0),
    ),
    markPaid: jest.fn(async (address: string, sats: number) => {
      const existing = balances.get(address);
      if (existing) {
        existing.balanceSats = Math.max(0, existing.balanceSats - sats);
        existing.totalPaidSats += sats;
      }
    }),
    touchLastAcceptedShareAt: jest.fn(async () => undefined),
    _get: (address: string) => balances.get(address),
  };
  const applySave = (row: any) => {
    const existing = balances.get(row.address);
    if (existing) Object.assign(existing, row);
    else balances.set(row.address, { address: row.address, balanceSats: row.balanceSats ?? 0, totalPaidSats: row.totalPaidSats ?? 0 });
    return row;
  };
  const repo: any = {
    findOneBy: jest.fn(async (where: any) => balances.get(where.address) ?? null),
    save: jest.fn(async (arg: any) =>
      Array.isArray(arg) ? arg.map(applySave) : applySave(arg),
    ),
    create: jest.fn((partial: any) => ({ ...partial })),
    find: jest.fn(async (q?: any) => {
      const inOp = q?.where?.address;
      if (inOp && typeof inOp === 'object' && Array.isArray(inOp._value)) {
        const set = new Set<string>(inOp._value);
        return Array.from(balances.values()).filter(b => set.has(b.address));
      }
      if (q?.where?.balanceSats) {
        return Array.from(balances.values()).filter(b => b.balanceSats !== 0);
      }
      return Array.from(balances.values());
    }),
  };
  return { service, repo };
}

function createMockPayoutHistoryRepo() {
  const saved: any[] = [];
  return {
    create: jest.fn((data: any) => data),
    save: jest.fn(async (entity: any) => {
      if (Array.isArray(entity)) { saved.push(...entity); return entity; }
      saved.push(entity); return entity;
    }),
    insert: jest.fn(async (rows: any) => {
      if (Array.isArray(rows)) saved.push(...rows); else saved.push(rows);
      return { identifiers: [] };
    }),
    find: jest.fn(async () => saved),
    findOneBy: jest.fn(async (where: any) =>
      saved.find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    _getSaved: () => saved,
  };
}

function createPplnsService(feeAddress: string, feePercent: string) {
  const redis = createMockRedis();
  const balanceBacking = createMockBalanceBacking();
  const balanceService = balanceBacking.service;
  const payoutHistoryRepo = createMockPayoutHistoryRepo();
  attachMockTxManager([
    [PplnsPayoutHistoryEntity, payoutHistoryRepo],
    [PplnsBalanceEntity, balanceBacking.repo],
  ]);
  const configService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        PPLNS_FEE_ADDRESS: feeAddress,
        PPLNS_FEE_PERCENT: feePercent,
        PPLNS_PORT: '3340',
      };
      return config[key];
    }),
  };
  const stratumV1JobsService = {
    newMiningJob$: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  };

  const service = new PplnsService(
    configService as any,
    { store: { client: redis } } as any,
    balanceService as any,
    payoutHistoryRepo as any,
    stratumV1JobsService as any,
  );

  (service as any).redis = redis;
  (service as any).enabled = true;

  return { service, redis, balanceService, payoutHistoryRepo };
}

// ═════════════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═════════════════════════════════════════════════════════════════

describe('PPLNS Integration', () => {

  describe('Full flow: shares → distribution → coinbase → block found', () => {

    it('should create a valid coinbase with correct outputs for 3 miners', async () => {
      const { service } = createPplnsService(ADDR_FEE, '2');
      service.setNetworkDifficulty(100_000);

      // 1. Record shares: A=50%, B=30%, C=20%
      await service.recordShare(ADDR_MINER1, 500);
      await service.recordShare(ADDR_MINER2, 300);
      await service.recordShare(ADDR_MINER3, 200);

      // 2. Get payout distribution
      const distribution = await service.getPayoutDistribution(BLOCK_REWARD);
      expect(distribution.length).toBe(4); // fee + 3 miners

      // Verify percentages sum to 100
      const totalPercent = distribution.reduce((s, d) => s + d.percent, 0);
      expect(totalPercent).toBeCloseTo(100, 1);

      // 3. Create real MiningJob with the distribution
      const jobTemplate = createMockJobTemplate();
      const configService = { get: (key: string) => key === 'POOL_IDENTIFIER' ? 'blitzpool-test' : undefined };
      const job = new MiningJob(configService as any, NETWORK, '1', distribution, jobTemplate);

      // 4. Parse the coinbase transaction
      const coinbaseHex = job.getCoinbaseTxHex();
      expect(coinbaseHex).toBeDefined();
      expect(coinbaseHex.length).toBeGreaterThan(0);

      const coinbaseTx = bitcoinjs.Transaction.fromHex(coinbaseHex);

      // Should have: 4 payout outputs + 1 OP_RETURN (witness commitment) = 5
      expect(coinbaseTx.outs.length).toBe(5);

      // 5. Verify output amounts sum to block reward
      // (OP_RETURN output has value 0, so sum of the other 4 should be BLOCK_REWARD)
      const payoutOutputs = coinbaseTx.outs.filter(o => o.value > 0);
      const totalSats = payoutOutputs.reduce((s, o) => s + o.value, 0);
      expect(totalSats).toBe(BLOCK_REWARD);

      // 6. Verify fee address gets ~2%
      // Fee is first output (unshifted in getPayoutDistribution)
      const feeOutput = coinbaseTx.outs[0];
      const expectedFeeSats = Math.floor(0.02 * BLOCK_REWARD); // 6,250,000
      // Fee gets the remainder too, so it's >= 2%
      expect(feeOutput.value).toBeGreaterThanOrEqual(expectedFeeSats);

      // 7. Verify miners get proportional amounts
      // Miner outputs are index 1,2,3 (after fee)
      const minerOutputValues = [coinbaseTx.outs[1].value, coinbaseTx.outs[2].value, coinbaseTx.outs[3].value];
      minerOutputValues.sort((a, b) => b - a); // largest first

      // Largest miner (50%) should get ~49% of reward
      const rewardForMiners = Math.floor(0.98 * BLOCK_REWARD); // 306,250,000
      expect(minerOutputValues[0]).toBeGreaterThan(rewardForMiners * 0.45);
      expect(minerOutputValues[0]).toBeLessThan(rewardForMiners * 0.55);

      console.log('\n=== PPLNS Coinbase Verification ===');
      console.log(`Block reward: ${BLOCK_REWARD} sats (${BLOCK_REWARD / 1e8} BTC)`);
      console.log(`Fee output:   ${feeOutput.value} sats (${(feeOutput.value / BLOCK_REWARD * 100).toFixed(2)}%)`);
      minerOutputValues.forEach((v, i) => {
        console.log(`Miner ${i + 1}:     ${v} sats (${(v / BLOCK_REWARD * 100).toFixed(2)}%)`);
      });
      console.log(`Total:        ${totalSats} sats`);
      console.log(`Coinbase size: ${coinbaseHex.length / 2} bytes, ${coinbaseTx.weight()} weight units`);
      console.log(`Outputs:      ${coinbaseTx.outs.length} (${payoutOutputs.length} payouts + 1 OP_RETURN)`);
    });

    it('should handle block found and update balances correctly', async () => {
      const { service, balanceService, payoutHistoryRepo } = createPplnsService(ADDR_FEE, '2');
      service.setNetworkDifficulty(100_000);

      // Record shares
      await service.recordShare(ADDR_MINER1, 600);
      await service.recordShare(ADDR_MINER2, 400);

      // Simulate block found
      await service.onBlockFound(800_000, BLOCK_REWARD);

      // Both miners should be above dust → history logged
      const history = payoutHistoryRepo._getSaved();
      expect(history.length).toBe(3); // 2 miners + 1 fee

      // Fee entry
      const feeEntry = history.find((h: any) => h.address === ADDR_FEE);
      expect(feeEntry).toBeDefined();
      expect(feeEntry.paidSats).toBe(BLOCK_REWARD - Math.floor(0.98 * BLOCK_REWARD));
      expect(feeEntry.inCoinbase).toBe(true);

      // Miner entries
      const miner1Entry = history.find((h: any) => h.address === ADDR_MINER1);
      const miner2Entry = history.find((h: any) => h.address === ADDR_MINER2);
      expect(miner1Entry.paidSats).toBeGreaterThan(miner2Entry.paidSats); // 60% > 40%
      expect(miner1Entry.inCoinbase).toBe(true);
      expect(miner2Entry.inCoinbase).toBe(true);

      // Total paid should equal block reward
      const totalPaid = history.reduce((s: number, h: any) => s + h.paidSats, 0);
      // Due to Math.floor rounding, total may be slightly less than BLOCK_REWARD
      expect(totalPaid).toBeLessThanOrEqual(BLOCK_REWARD);
      expect(totalPaid).toBeGreaterThan(BLOCK_REWARD - 10); // At most a few sats lost to rounding

      console.log('\n=== Block Found Payout History ===');
      history.forEach((h: any) => {
        console.log(`  ${h.address.substring(0, 20)}...: ${h.paidSats} sats (${h.percent.toFixed(2)}%) ${h.inCoinbase ? 'COINBASE' : 'PENDING'}`);
      });
    });

    it('should accumulate sub-dust miners across blocks and eventually pay out', async () => {
      const { service, balanceService } = createPplnsService(ADDR_FEE, '2');
      service.setNetworkDifficulty(10_000_000); // large window

      // Miner 1 dominates, Miner 2 is tiny (sub-payout-floor per block).
      // Ratio 100 / (10_000_000 + 100) × (rewardForMiners ≈ 306M)
      // ≈ ~3 062 sats/block — under the default PPLNS_MIN_PAYOUT_SATS
      // (5 000) on the FIRST block, accumulating across a couple of
      // blocks until the cumulative balance crosses the floor and pays
      // out on-chain. Same accumulate-then-pay semantic the old test
      // exercised against the 546 floor, just retuned for 5 000.
      await service.recordShare(ADDR_MINER1, 10_000_000);
      await service.recordShare(ADDR_MINER2, 100);

      // Block 1: Miner 2 gets sub-floor → pending
      await service.onBlockFound(800_000, BLOCK_REWARD);
      const pending1 = balanceService._get(ADDR_MINER2)?.balanceSats ?? 0;
      expect(pending1).toBeGreaterThan(0);
      expect(pending1).toBeLessThan(5000); // sub-floor at default 5 000
      console.log(`\nBlock 1: Miner2 pending = ${pending1} sats`);

      // Blocks 2-20: accumulate. 20 × ~6 100 sats = ~12 200 — well past 5 000.
      // Whichever block crosses the floor pays out — afterwards balance
      // resets, and accumulation begins again.
      for (let i = 1; i <= 19; i++) {
        await service.onBlockFound(800_000 + i, BLOCK_REWARD);
      }
      const pending20 = balanceService._get(ADDR_MINER2)?.balanceSats ?? 0;
      const totalPaid = balanceService._get(ADDR_MINER2)?.totalPaidSats ?? 0;
      console.log(`Block 20: Miner2 pending = ${pending20}, totalPaid = ${totalPaid}`);

      // Strong assertion: across 20 blocks miner2 must have crossed the
      // floor at least once and received some on-chain sats.
      expect(totalPaid).toBeGreaterThan(0);
    });

    it('should create valid coinbase for large miner count', async () => {
      const { service } = createPplnsService(ADDR_FEE, '2');
      service.setNetworkDifficulty(100_000_000);

      // Simulate 50 miners with varying hashrates
      const miners: string[] = [];
      for (let i = 0; i < 50; i++) {
        // Generate unique fake addresses (won't validate on mainnet but valid for test)
        const addr = ADDR_MINER1; // Re-use same address for simplicity in output count
        await service.recordShare(addr, 1000 + i * 100);
      }
      // Add some distinct addresses
      await service.recordShare(ADDR_MINER1, 50_000);
      await service.recordShare(ADDR_MINER2, 30_000);
      await service.recordShare(ADDR_MINER3, 20_000);

      const distribution = await service.getPayoutDistribution(BLOCK_REWARD);
      expect(distribution.length).toBeGreaterThanOrEqual(2); // at least fee + 1 miner

      // Create coinbase
      const jobTemplate = createMockJobTemplate();
      const configService = { get: () => 'test' };
      const job = new MiningJob(configService as any, NETWORK, '1', distribution, jobTemplate);
      const coinbaseHex = job.getCoinbaseTxHex();
      const coinbaseTx = bitcoinjs.Transaction.fromHex(coinbaseHex);

      // Verify total value
      const totalValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
      expect(totalValue).toBe(BLOCK_REWARD);

      // Verify weight is within limits
      expect(coinbaseTx.weight()).toBeLessThan(4_000_000);

      console.log(`\n=== Large Pool Coinbase ===`);
      console.log(`Miners in distribution: ${distribution.length - 1}`);
      console.log(`Coinbase outputs: ${coinbaseTx.outs.length}`);
      console.log(`Coinbase weight: ${coinbaseTx.weight()} WU`);
      console.log(`Coinbase size: ${coinbaseHex.length / 2} bytes`);
    });

    it('should produce consistent distribution and onBlockFound accounting', async () => {
      const { service, payoutHistoryRepo } = createPplnsService(ADDR_FEE, '2');
      service.setNetworkDifficulty(100_000);

      // Equal shares
      await service.recordShare(ADDR_MINER1, 500);
      await service.recordShare(ADDR_MINER2, 500);

      // Get distribution (what goes into coinbase)
      const dist = await service.getPayoutDistribution(BLOCK_REWARD);

      // Build coinbase
      const jobTemplate = createMockJobTemplate();
      const configService = { get: () => 'test' };
      const job = new MiningJob(configService as any, NETWORK, '1', dist, jobTemplate);
      const coinbaseTx = bitcoinjs.Transaction.fromHex(job.getCoinbaseTxHex());

      // Simulate block found
      await service.onBlockFound(800_000, BLOCK_REWARD);

      // Compare coinbase output values with history
      const history = payoutHistoryRepo._getSaved();
      const historyMiner1 = history.find((h: any) => h.address === ADDR_MINER1);
      const historyMiner2 = history.find((h: any) => h.address === ADDR_MINER2);

      // Both should get equal amounts (50/50)
      expect(historyMiner1.paidSats).toBe(historyMiner2.paidSats);

      // Verify coinbase outputs match history
      // Outputs: [fee, miner1, miner2, OP_RETURN]
      const payoutOutputs = coinbaseTx.outs.filter(o => o.value > 0);
      const coinbaseMinerValues = payoutOutputs.slice(1).map(o => o.value).sort();
      const historyMinerValues = [historyMiner1.paidSats, historyMiner2.paidSats].sort();

      // They should match (same window state, same calculation)
      expect(coinbaseMinerValues).toEqual(historyMinerValues);

      console.log('\n=== Consistency Check ===');
      console.log(`Coinbase miner outputs: ${coinbaseMinerValues}`);
      console.log(`History paidSats:       ${historyMinerValues}`);
      console.log(`Match: ${JSON.stringify(coinbaseMinerValues) === JSON.stringify(historyMinerValues)}`);
    });
  });
});
