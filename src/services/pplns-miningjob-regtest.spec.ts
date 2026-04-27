/**
 * PPLNS × MiningJob Regtest — end-to-end production coinbase path.
 *
 * Closes the gap between the existing regtest suites:
 *
 *   - pplns-regtest.spec: PPLNS distribution → custom buildCoinbase → Core
 *   - v1-solo-regtest.spec: MiningJob → Core (but only 1-2 outputs)
 *
 * THIS test: PPLNS distribution → real MiningJob.createCoinbaseTransaction
 * (with the percent→sats float round-trip) → submitblock to Core.
 *
 * If the round-trip through MiningJob's `Math.floor((percent / 100) * reward)`
 * ever drifts from `buildCoinbaseDistribution`'s authoritative `sats` values,
 * Core will reject the block with `bad-cb-amount` and these tests will fail.
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test,
 * rpcpassword=test).
 *
 * Run: npx jest pplns-miningjob-regtest --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { MiningJob } from '../models/MiningJob';
import { IJobTemplate } from './stratum-v1-jobs.service';
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import {
    NETWORK,
    rpcCall,
    mineBlock,
    createMockRedis,
} from './__test-helpers__/regtest-harness';

// ── Addresses ────────────────────────────────────────────────────

const ADDR_FEE     = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ALICE   = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB     = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';
const ADDR_CHARLIE = 'bcrt1qlppw7cnqspnky6qzv8p2n468lpvwuct7ehp7l2';

function generateTestMinerAddresses(count: number): string[] {
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) {
        const hash = crypto.createHash('ripemd160')
            .update(crypto.createHash('sha256').update(`pplns-miningjob-regtest-miner-${i}`).digest())
            .digest();
        const addr = bitcoinjs.payments.p2wpkh({ hash, network: NETWORK }).address!;
        addresses.push(addr);
    }
    return addresses;
}

// ── IJobTemplate from getblocktemplate (same as v1-solo-regtest) ──

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
    merkleBranches.pop(); // drop merkle root
    const merkle_branch = merkleBranches.slice(1).map(b => b.toString('hex'));

    const block = new bitcoinjs.Block();
    block.version = template.version;
    block.prevHash = Buffer.from(template.previousblockhash, 'hex').reverse();
    block.timestamp = template.curtime;
    block.bits = parseInt(template.bits, 16);
    block.merkleRoot = Buffer.alloc(32); // placeholder; MiningJob recomputes
    block.transactions = txsWithDummy;
    block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(txsWithDummy, true);

    return {
        block,
        merkle_branch,
        blockData: {
            id: `regtest-pplns-mj-${idSuffix}`,
            creation: Date.now(),
            coinbasevalue: template.coinbasevalue,
            networkDifficulty: 1,
            height: template.height,
            clearJobs: true,
        },
    };
}

function makeConfigService() {
    const env: Record<string, string> = { POOL_IDENTIFIER: 'blitzpool-pplns-mj-regtest' };
    return { get: (key: string) => env[key] } as any;
}

// ── PPLNS service mock stack ─────────────────────────────────────

function createMockBalanceBacking() {
    const rows: any[] = [];
    const find = (addr: string) => rows.find((r: any) => r.address === addr);
    const service = {
        getAllWithBalance: async () => rows.filter((r: any) => r.balanceSats !== 0),
        getBalanceSats: async (addr: string) => find(addr)?.balanceSats ?? 0,
        addBalance: async (addr: string, sats: number) => {
            const existing = find(addr);
            if (existing) existing.balanceSats += sats;
            else rows.push({ address: addr, balanceSats: sats, totalPaidSats: 0 });
        },
        markPaid: async (addr: string, sats: number) => {
            const existing = find(addr);
            if (existing) {
                existing.balanceSats = Math.max(0, existing.balanceSats - sats);
                existing.totalPaidSats += sats;
            }
        },
        touchLastAcceptedShareAt: async (_addr: string) => undefined,
        _rows: rows,
    };
    const applySave = (row: any) => {
        const existing = find(row.address);
        if (existing) Object.assign(existing, row);
        else rows.push(row);
        return row;
    };
    const repo: any = {
        findOneBy: async (where: any) => find(where.address) ?? null,
        save: async (arg: any) =>
            Array.isArray(arg) ? arg.map(applySave) : applySave(arg),
        insert: async (arg: any) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        },
        create: (partial: any) => ({ ...partial }),
        find: async (q: any) => {
            const inOp = q?.where?.address;
            if (inOp && typeof inOp === 'object' && Array.isArray(inOp._value)) {
                const set = new Set<string>(inOp._value);
                return rows.filter((r: any) => set.has(r.address));
            }
            if (q?.where?.balanceSats) return rows.filter((r: any) => r.balanceSats !== 0);
            return [...rows];
        },
        _rows: rows,
    };
    return { service, repo, _rows: rows };
}

function createMockHistoryRepo() {
    const rows: any[] = [];
    return {
        save: async (arg: any) => {
            if (Array.isArray(arg)) { for (const r of arg) rows.push(r); return arg; }
            rows.push(arg); return arg;
        },
        insert: async (arg: any) => {
            const batch = Array.isArray(arg) ? arg : [arg];
            for (const row of batch) rows.push(row);
            return { identifiers: [] };
        },
        create: (partial: any) => ({ ...partial }),
        findOneBy: async (where: any) =>
            rows.find((r: any) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
        _rows: rows,
    } as any;
}

function makeService(opts: { feeAddress?: string; feePercent?: string } = {}) {
    const env: Record<string, string> = {
        PPLNS_PORT: '3336',
        PPLNS_FEE_ADDRESS: opts.feeAddress ?? ADDR_FEE,
        PPLNS_FEE_PERCENT: opts.feePercent ?? '2',
    };
    const balanceBacking = createMockBalanceBacking();
    const historyRepo = createMockHistoryRepo();
    attachMockTxManager([
        [PplnsPayoutHistoryEntity, historyRepo],
        [PplnsBalanceEntity, balanceBacking.repo],
    ]);
    const service = new PplnsService(
        { get: (k: string) => env[k] } as any,
        { store: {} } as any,
        balanceBacking.service as any,
        historyRepo as any,
        { newMiningJob$: { subscribe: () => ({ unsubscribe: () => undefined }) } } as any,
    );
    const redis = createMockRedis();
    (service as any).redis = redis;
    (service as any).enabled = true;
    service.setNetworkDifficulty(1e12);
    return { service, redis, balanceService: balanceBacking.service, historyRepo };
}

// ── Block assembly via production MiningJob ──────────────────────

async function assembleWithMiningJob(
    distribution: { address: string; percent: number }[],
    testId: string,
): Promise<{ submitResult: any; template: any; coinbaseTx: bitcoinjs.Transaction }> {
    const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
    const jobTemplate = buildJobTemplate(template, testId);

    // This is the EXACT production path:
    // MiningJob receives { address, percent }[] and re-derives sats via
    // Math.floor((percent / 100) * reward). The remainder goes to outs[0].
    const miningJob = new MiningJob(
        makeConfigService(),
        NETWORK,
        `pplns-mj-${testId}`,
        distribution,
        jobTemplate,
    );

    // copyAndUpdateBlock slots the MiningJob's coinbase into the block and
    // recomputes the merkle root — same path as StratumV1Client.
    const block = miningJob.copyAndUpdateBlock(
        jobTemplate, 0, 0, '00000000', '00000000',
        template.curtime,
    );

    if (!await mineBlock(block, template.target)) {
        throw new Error('nonce exhausted');
    }

    const submitResult = await rpcCall('submitblock', [block.toHex(false)]);
    const coinbaseTx = miningJob.cloneCoinbaseTransaction();

    return { submitResult, template, coinbaseTx };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('PPLNS × MiningJob Regtest — production coinbase path', () => {

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
            const wallets: string[] = await rpcCall('listwallets');
            for (const name of wallets) {
                if (name !== 'default') {
                    try { await rpcCall('unloadwallet', [name]); } catch { /* ignore */ }
                }
            }
            if (!wallets.includes('default')) {
                try { await rpcCall('createwallet', ['default']); } catch { /* already */ }
            }
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch (e) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443 — ${(e as Error).message}`);
        }
    });

    it('PPLNS 3-miner distribution via MiningJob: Core accepts block', async () => {
        const { service, balanceService } = makeService();

        // Seed pending balances (same scenario as pplns-regtest.spec)
        (balanceService._rows as any[]).push(
            { address: ADDR_CHARLIE, balanceSats: 50_000, totalPaidSats: 0 },
            { address: ADDR_ALICE, balanceSats: 1_500, totalPaidSats: 0 },
        );

        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        // Sanity: fee + at least Alice + Bob
        const addrs = distribution.map(d => d.address);
        expect(addrs).toContain(ADDR_FEE);
        expect(addrs).toContain(ADDR_ALICE);
        expect(addrs).toContain(ADDR_BOB);

        const totalPct = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);

        // THE KEY TEST: production MiningJob builds the coinbase, Core validates.
        const { submitResult, coinbaseTx } = await assembleWithMiningJob(distribution, 'pplns-3');
        expect(submitResult).toBeNull();

        // Verify coinbase total = block reward (MiningJob remainder logic)
        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        // Output count: distribution entries + 1 OP_RETURN witness commitment
        expect(coinbaseTx.outs.length).toBe(distribution.length + 1);

        console.log(`✅ PPLNS 3-miner via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);

    it('PPLNS 20-miner distribution via MiningJob: Core accepts block', async () => {
        const { service } = makeService();
        const miners = generateTestMinerAddresses(20);

        // Varied share weights so distribution is non-trivial
        for (let i = 0; i < miners.length; i++) {
            const weight = 100_000 * (20 - i) + 1; // descending weights
            await service.recordShare(miners[i], weight);
        }

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        expect(distribution.length).toBeGreaterThanOrEqual(2); // fee + at least some miners

        const totalPct = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);

        const { submitResult, coinbaseTx } = await assembleWithMiningJob(distribution, 'pplns-20');
        expect(submitResult).toBeNull();

        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        console.log(`✅ PPLNS 20-miner via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);

    it('percent→sats round-trip: MiningJob amounts match buildCoinbaseDistribution sats', async () => {
        // Verify MiningJob's float round-trip doesn't drift from the
        // authoritative integer sats computed by buildCoinbaseDistribution.
        const { service } = makeService();
        const miners = generateTestMinerAddresses(15);

        for (let i = 0; i < miners.length; i++) {
            await service.recordShare(miners[i], 50_000 * (i + 1));
        }

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);
        const blockReward = template.coinbasevalue;

        // Re-derive amounts the way MiningJob does (the float round-trip)
        const mjAmounts: number[] = [];
        let mjRewardBalance = blockReward;
        for (const entry of distribution) {
            const amount = Math.floor((entry.percent / 100) * blockReward);
            mjAmounts.push(amount);
            mjRewardBalance -= amount;
        }
        // MiningJob adds remainder to outs[0]
        mjAmounts[0] += mjRewardBalance;

        // Compare to authoritative sats
        const authSats = distribution.map(d => d.sats);
        // The first entry may differ by the remainder amount (which is fine —
        // both paths ensure total == blockReward). What matters is that the
        // TOTAL never exceeds blockReward.
        const mjTotal = mjAmounts.reduce((s, v) => s + v, 0);
        const authTotal = authSats.reduce((s, v) => s + v, 0);

        expect(mjTotal).toBe(blockReward);
        expect(authTotal).toBeLessThanOrEqual(blockReward);

        // Per-entry drift should be tiny (only floor-rounding differences)
        for (let i = 0; i < distribution.length; i++) {
            const drift = Math.abs(mjAmounts[i] - authSats[i]);
            // Remainder goes to outs[0], so allow up to N-1 sats drift there
            const maxDrift = i === 0 ? distribution.length : 1;
            expect(drift).toBeLessThanOrEqual(maxDrift);
        }

        // And Core must still accept it
        const { submitResult } = await assembleWithMiningJob(distribution, 'pplns-roundtrip');
        expect(submitResult).toBeNull();

        console.log(
            `✅ PPLNS percent→sats round-trip: mjTotal=${mjTotal}, authTotal=${authTotal}, ` +
            `drift[0]=${Math.abs(mjAmounts[0] - authSats[0])}, Core accepted`,
        );
    }, 120_000);

    it('PPLNS with P2TR + P2WPKH mixed addresses via MiningJob: Core accepts', async () => {
        // MiningJob.getPaymentScript uses getAddressInfo + bitcoinjs.payments.*
        // This verifies P2TR addresses (which use a different script path than
        // P2WPKH) also produce valid coinbase outputs through the production path.
        const { service } = makeService();

        // Generate P2TR addresses (32-byte x-only pubkey witness program)
        const p2trAddresses: string[] = [];
        for (let i = 0; i < 3; i++) {
            const internalKey = crypto.createHash('sha256')
                .update(`pplns-mj-p2tr-test-${i}`)
                .digest();
            // x-only pubkey must be 32 bytes; use the hash directly
            const addr = bitcoinjs.payments.p2tr({
                internalPubkey: internalKey,
                network: NETWORK,
            }).address!;
            p2trAddresses.push(addr);
        }

        // Mix P2WPKH (fee, Alice, Bob) and P2TR addresses
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 100);
        for (const addr of p2trAddresses) {
            await service.recordShare(addr, 100);
        }

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        const { submitResult, coinbaseTx } = await assembleWithMiningJob(distribution, 'pplns-mixed');
        expect(submitResult).toBeNull();

        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        console.log(`✅ PPLNS mixed P2WPKH+P2TR via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);
});
