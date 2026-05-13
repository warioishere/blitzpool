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
import * as ecc from 'tiny-secp256k1';
import * as crypto from 'crypto';

bitcoinjs.initEccLib(ecc);
import { PplnsService } from './pplns.service';
import { PplnsPayoutHistoryEntity } from '../ORM/pplns-balance/pplns-payout-history.entity';
import { PplnsBalanceEntity } from '../ORM/pplns-balance/pplns-balance.entity';
import { attachMockTxManager } from './__test-helpers__/mock-tx-manager';
import {
    NETWORK,
    rpcCall,
    createMockRedis,
    assembleWithMiningJobAndTemplate,
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
        markTouch: (_addr: string) => undefined,
        flushPendingTouches: async () => undefined,
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
        const { service, balanceService, historyRepo } = makeService();

        // Seed pending balances (same scenario as pplns-regtest.spec)
        (balanceService._rows as any[]).push(
            { address: ADDR_CHARLIE, balanceSats: 50_000, totalPaidSats: 0 },
            { address: ADDR_ALICE, balanceSats: 1_500, totalPaidSats: 0 },
        );

        await service.recordShare(ADDR_ALICE, 100);
        await service.recordShare(ADDR_BOB, 200);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        const addrs = distribution.map(d => d.address);
        expect(addrs).toContain(ADDR_FEE);
        expect(addrs).toContain(ADDR_ALICE);
        expect(addrs).toContain(ADDR_BOB);

        const totalPct = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);

        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-3');
        expect(submitResult).toBeNull();

        // Coinbase total = block reward (MiningJob remainder logic)
        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        // Output count: distribution entries + 1 OP_RETURN witness commitment
        expect(coinbaseTx.outs.length).toBe(distribution.length + 1);

        // onBlockFound books history rows for each distribution entry
        await service.onBlockFound(template.height, template.coinbasevalue);
        const historyRows = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyRows.length).toBe(distribution.length);
        expect(historyRows.map(r => r.address).sort())
            .toEqual(distribution.map(d => d.address).sort());

        console.log(`✅ PPLNS 3-miner via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);

    it('PPLNS 20-miner distribution via MiningJob: Core accepts block', async () => {
        const { service, historyRepo } = makeService();
        const miners = generateTestMinerAddresses(20);

        for (let i = 0; i < miners.length; i++) {
            const weight = 100_000 * (20 - i) + 1;
            await service.recordShare(miners[i], weight);
        }

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        expect(distribution.length).toBeGreaterThanOrEqual(2);

        const totalPct = distribution.reduce((s, d) => s + d.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);

        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-20');
        expect(submitResult).toBeNull();

        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        await service.onBlockFound(template.height, template.coinbasevalue);
        const historyRows = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyRows.length).toBe(distribution.length);

        console.log(`✅ PPLNS 20-miner via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);

    it('percent→sats round-trip: MiningJob amounts match buildCoinbaseDistribution sats', async () => {
        const { service, historyRepo } = makeService();
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

        const authSats = distribution.map(d => d.sats);
        const mjTotal = mjAmounts.reduce((s, v) => s + v, 0);
        const authTotal = authSats.reduce((s, v) => s + v, 0);

        expect(mjTotal).toBe(blockReward);
        expect(authTotal).toBeLessThanOrEqual(blockReward);

        // Per-entry drift should be tiny (only floor-rounding differences)
        for (let i = 0; i < distribution.length; i++) {
            const drift = Math.abs(mjAmounts[i] - authSats[i]);
            const maxDrift = i === 0 ? distribution.length : 1;
            expect(drift).toBeLessThanOrEqual(maxDrift);
        }

        const { submitResult } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-roundtrip');
        expect(submitResult).toBeNull();

        await service.onBlockFound(template.height, blockReward);
        const historyRows = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyRows.length).toBe(distribution.length);

        console.log(
            `✅ PPLNS percent→sats round-trip: mjTotal=${mjTotal}, authTotal=${authTotal}, ` +
            `drift[0]=${Math.abs(mjAmounts[0] - authSats[0])}, Core accepted`,
        );
    }, 120_000);

    it('PPLNS with all 5 address types (P2WPKH+P2TR+P2PKH+P2WSH+P2SH) via MiningJob: Core accepts', async () => {
        // Exercises every branch of MiningJob.getPaymentScript — one miner per
        // address type. Core accepting the block proves all output scripts are valid.
        const { service, historyRepo } = makeService();

        // P2TR (taproot, bech32m, bcrt1p…)
        const p2trPriv = crypto.createHash('sha256').update('pplns-mj-p2tr-0').digest();
        const p2trCompressed = ecc.pointFromScalar(p2trPriv, true)!;
        const addrP2TR = bitcoinjs.payments.p2tr({
            internalPubkey: Buffer.from(p2trCompressed.slice(1)),
            network: NETWORK,
        }).address!;

        // P2PKH (legacy base58, m… on regtest)
        const p2pkhPriv = crypto.createHash('sha256').update('pplns-mj-p2pkh').digest();
        const p2pkhPub = Buffer.from(ecc.pointFromScalar(p2pkhPriv, true)!);
        const addrP2PKH = bitcoinjs.payments.p2pkh({ pubkey: p2pkhPub, network: NETWORK }).address!;

        // P2WSH (segwit v0, 32-byte script hash, bcrt1q… 62 chars)
        const p2wshPriv = crypto.createHash('sha256').update('pplns-mj-p2wsh').digest();
        const p2wshPub = Buffer.from(ecc.pointFromScalar(p2wshPriv, true)!);
        const addrP2WSH = bitcoinjs.payments.p2wsh({
            redeem: bitcoinjs.payments.p2pk({ pubkey: p2wshPub, network: NETWORK }),
            network: NETWORK,
        }).address!;

        // P2SH (legacy base58, 2… on regtest — same version byte as testnet)
        const p2shPriv = crypto.createHash('sha256').update('pplns-mj-p2sh').digest();
        const p2shPub = Buffer.from(ecc.pointFromScalar(p2shPriv, true)!);
        const addrP2SH = bitcoinjs.payments.p2sh({
            redeem: bitcoinjs.payments.p2pk({ pubkey: p2shPub, network: NETWORK }),
            network: NETWORK,
        }).address!;

        await service.recordShare(ADDR_ALICE, 100);  // P2WPKH
        await service.recordShare(addrP2TR, 100);    // P2TR
        await service.recordShare(addrP2PKH, 100);   // P2PKH
        await service.recordShare(addrP2WSH, 100);   // P2WSH
        await service.recordShare(addrP2SH, 100);    // P2SH

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const distribution = await service.getPayoutDistribution(template.coinbasevalue);

        // All 5 miner types + fee must appear (assuming none fall below dust)
        const addrs = distribution.map(d => d.address);
        expect(addrs).toContain(ADDR_FEE);
        expect(addrs).toContain(addrP2PKH);
        expect(addrs).toContain(addrP2SH);

        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(distribution, template, 'pplns-alltypes');
        expect(submitResult).toBeNull();

        const totalCoinbaseValue = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(totalCoinbaseValue).toBe(template.coinbasevalue);

        await service.onBlockFound(template.height, template.coinbasevalue);
        const historyRows = (historyRepo._rows as any[]).filter(
            r => r.blockHeight === template.height && r.rowType === 'coinbase',
        );
        expect(historyRows.length).toBe(distribution.length);

        console.log(`✅ PPLNS all 5 address types via MiningJob: ${distribution.length} outputs, Core accepted`);
    }, 120_000);
});
