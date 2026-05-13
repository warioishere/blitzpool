/**
 * Group-Solo Regtest Integration Tests — Lifecycle scenarios.
 *
 * Three scenarios exercised against a live Bitcoin Core regtest node,
 * each ending in a block submit so we prove the coinbase math matches
 * what bitcoind will accept:
 *
 *   1. kick-redistribute  — kicking a member flushes their pending into
 *                            the remaining members; on the next block
 *                            the coinbase has no output for the kicked
 *                            miner and the survivors' pending carries
 *                            the redistribution.
 *
 *   2. dust-fee-gate      — when feePercent * blockRewardSats < 546 sat
 *                            the fee output is silently dropped and
 *                            miners keep 100 % of the block. The block
 *                            must still validate with the reduced
 *                            output set.
 *
 *   3. snapshot-persist   — getPayoutDistribution writes the snapshot to
 *                            Redis; we spin up a fresh GroupSoloService
 *                            instance (simulating a pool restart), feed
 *                            it the same Redis backing store, and call
 *                            onBlockFound. It must use the persisted
 *                            snapshot, not the current-window fallback.
 *
 * Block builder copied from group-solo-regtest.spec.ts — same
 * invariants: height ≥ 17 for BIP34 scriptSig encoding, witness
 * commitment computed over (dummyCoinbase + template transactions),
 * block submitted with block.toHex(false) (no witnesses on outer
 * serialization; Core picks up witnesses from the txs themselves).
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

function makeService(env: Record<string, string>) {
    const addressToGroup = new Map<string, { groupId: string; active: boolean }>();
    addressToGroup.set(ADDR_ALICE, { groupId: 'grp-1', active: true });
    addressToGroup.set(ADDR_BOB, { groupId: 'grp-1', active: true });
    addressToGroup.set(ADDR_CHARLIE, { groupId: 'grp-1', active: true });

    const balanceRepo = createMockRepo();
    const historyRepo = createMockRepo();
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
    return { service, redis, balanceRepo, historyRepo, addressToGroup };
}


// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Group-Solo Regtest Lifecycle', () => {

    beforeAll(async () => {
        try {
            const info = await rpcCall('getblockchaininfo');
            expect(info.chain).toBe('regtest');
            // Force single-wallet state — unscoped wallet RPCs are ambiguous
            // if a stale wallet from a prior session is still attached.
            const wallets: string[] = await rpcCall('listwallets');
            for (const name of wallets) {
                if (name !== 'default') {
                    try { await rpcCall('unloadwallet', [name]); } catch { /* ignore */ }
                }
            }
            if (!wallets.includes('default')) {
                try { await rpcCall('createwallet', ['default']); } catch { /* already */ }
            }
            // Need chain height ≥ 17 for BIP34 scriptSig encoding.
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch (e) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443 — ${(e as Error).message}`);
        }
    });

    // ── 1. Kick redistributes pending; next block validates without kicked output ───
    it('kick-redistribute: survivors absorb pending, block validates without kicked output', async () => {
        const { service, balanceRepo, addressToGroup } = makeService({
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
        });

        // Seed Charlie with pending from an earlier sub-dust round.
        (balanceRepo._rows as any[]).push({
            address: ADDR_CHARLIE, groupId: 'grp-1', pendingSats: 900, totalPaidSats: 0,
        });

        // Alice + Bob + Charlie all mine this round.
        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);
        await service.recordShare(ADDR_CHARLIE, 300);

        // Admin kicks Charlie; survivors are Alice + Bob.
        await service.removeMemberState('grp-1', ADDR_CHARLIE, [ADDR_ALICE, ADDR_BOB]);

        // Charlie's 900 sats pending splits 450/450 into Alice + Bob.
        const aliceRow = (balanceRepo._rows as any[]).find(r => r.address === ADDR_ALICE);
        const bobRow = (balanceRepo._rows as any[]).find(r => r.address === ADDR_BOB);
        expect(aliceRow?.pendingSats).toBe(450);
        expect(bobRow?.pendingSats).toBe(450);
        expect((balanceRepo._rows as any[]).find(r => r.address === ADDR_CHARLIE)).toBeUndefined();

        // Charlie stops mining.
        addressToGroup.delete(ADDR_CHARLIE);

        // Build distribution → submit block to Core.
        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution('grp-1', template.coinbasevalue);

        // No Charlie in the distribution.
        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_CHARLIE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB, ADDR_FEE].sort());

        // Production MiningJob path — same template used for distribution and block.
        const mjDist = distribution.map(d => ({ address: d.address, percent: d.percent }));
        const { submitResult } = await assembleWithMiningJobAndTemplate(mjDist, template, 'gs-kick');
        expect(submitResult).toBeNull();

        // onBlockFound: solvency cap fires because survivors' redistributed pending
        // (450 sats each) adds to their on-chain cut and overshoots the block reward
        // by exactly 900 sats. The cap clips the full credit amount from each miner,
        // so both pending balances carry forward unchanged at 450.
        await service.onBlockFound(template.height, template.coinbasevalue, ADDR_ALICE);
        const aliceAfter = (balanceRepo._rows as any[]).find(r => r.address === ADDR_ALICE);
        const bobAfter = (balanceRepo._rows as any[]).find(r => r.address === ADDR_BOB);
        expect(aliceAfter).toBeDefined();
        expect(bobAfter).toBeDefined();
        expect(aliceAfter.totalPaidSats).toBeGreaterThan(0);
        expect(bobAfter.totalPaidSats).toBeGreaterThan(0);
        // Solvency cap fully defers the redistributed pending → carry-forward ≈ 450.
        // ±1 sat tolerance: the residuum sat from Phase 5b goes to Bob (highest weight),
        // but the snapshot stores percents, so onBlockFound's Math.floor re-derivation
        // may lose that residuum sat for Bob.
        expect(aliceAfter.pendingSats).toBeGreaterThanOrEqual(449);
        expect(aliceAfter.pendingSats).toBeLessThanOrEqual(450);
        expect(bobAfter.pendingSats).toBeGreaterThanOrEqual(449);
        expect(bobAfter.pendingSats).toBeLessThanOrEqual(450);

        console.log('✅ kick-redistribute: survivors absorbed charlie\'s pending, block validated');
    }, 120000);

    // ── 2. Dust-fee gate drops the fee output; block still validates ──
    it('dust-fee-gate: tiny feePercent → fee omitted, miners keep 100 %, block valid', async () => {
        // On regtest the subsidy is 50 BTC = 5_000_000_000 sats at early
        // heights. 0.00001 % → 0.0000001 × 5e9 = 500 sats < DUST_LIMIT 546.
        const { service, historyRepo } = makeService({
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '0.00001',
        });

        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution('grp-1', template.coinbasevalue);

        // Dust-gate must drop the fee output.
        const addrs = distribution.map(d => d.address);
        expect(addrs).not.toContain(ADDR_FEE);
        expect(addrs.sort()).toEqual([ADDR_ALICE, ADDR_BOB].sort());

        // Miners together should receive effectively 100 %. Proportional
        // residuum distribution in Phase 5b may leave up to 1 sat of
        // floor-rounding drift across recipients — loosen the precision
        // to 2 decimals (< 0.005 % drift).
        const totalPercent = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPercent).toBeCloseTo(100, 2);

        const mjDist = distribution.map(d => ({ address: d.address, percent: d.percent }));
        const { submitResult } = await assembleWithMiningJobAndTemplate(mjDist, template, 'gs-dust');
        expect(submitResult).toBeNull();

        await service.onBlockFound(template.height, template.coinbasevalue, ADDR_ALICE);
        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyForBlock.length).toBe(distribution.length);

        console.log('✅ dust-fee-gate: fee omitted from coinbase, block accepted');
    }, 120000);

    // ── 3. Snapshot persists across service-instance restart ──────
    it('snapshot-persist: distribution snapshot survives service restart via Redis', async () => {
        const env = {
            GROUP_SOLO_PORT: '3340',
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
        };
        const { service: svcA, redis, balanceRepo, historyRepo, addressToGroup } = makeService(env);

        await svcA.recordShare(ADDR_ALICE, 100);
        await svcA.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;

        // svcA writes the snapshot (simulating the moment the miner
        // receives the coinbase template). Snapshots are now keyed per
        // finderAddress; without one passed, the legacy "__none__" key
        // is used, which keeps the cross-restart behavior intact.
        const distributionA = await svcA.getPayoutDistribution('grp-1', blockReward);
        expect(redis._hashes.has(`groupsolo:grp-1:snapshot:__none__`)).toBe(true);

        // Simulate pool restart: new service instance, same Redis.
        const svcB = new GroupSoloService(
            { get: (k: string) => env[k] } as any,
            { store: {} } as any,
            historyRepo as any,
            balanceRepo as any,
            { findOneBy: jest.fn(async () => null), update: jest.fn() } as any,
            { getGroupForAddress: (a: string) => addressToGroup.get(a) } as any,
        );
        (svcB as any).redis = redis;
        (svcB as any).enabled = true;
        // svcB.snapshots is a fresh empty Map — if the service used
        // only in-memory state, it would fall back to
        // onBlockFoundFromWindow and book payouts differently.

        const mjDist = distributionA.map(d => ({ address: d.address, percent: d.percent }));
        const { submitResult } = await assembleWithMiningJobAndTemplate(mjDist, template, 'gs-snapshot');
        expect(submitResult).toBeNull();

        // onBlockFound on svcB must read from Redis.
        await svcB.onBlockFound(template.height, template.coinbasevalue, ADDR_ALICE);

        const historyForBlock = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyForBlock.length).toBe(distributionA.length);
        expect(historyForBlock.map(r => r.address).sort())
            .toEqual(distributionA.map(d => d.address).sort());

        // Per-finder snapshot keys consumed by deleteAllSnapshots after onBlockFound.
        for (const k of redis._store.keys()) {
            expect(k).not.toMatch(/^groupsolo:grp-1:snapshot/);
        }

        console.log('✅ snapshot-persist: fresh service instance consumed Redis snapshot');
    }, 120000);
});
