/**
 * Blockparty Regtest — mixed-address-type coinbase
 *
 * Cluster B regression: Blockparty coinbase produces N+1 outputs (pool
 * fee + N members), where each member address can be any BTC type.
 * This spec verifies that a 4-address mix (P2WPKH-Admin + P2PKH-Member
 * + P2TR-Member + P2WPKH-Member) gets encoded with the right
 * scriptPubKey for each type and that Bitcoin Core 29 accepts the
 * resulting block.
 *
 * Pool fee address stays P2WPKH (the canonical configuration). Member
 * roster is wallet-generated at test time so we don't hard-code
 * regtest-network-specific bech32/legacy values.
 *
 * Run: npx jest src/services/blockparty-regtest-mixed-addresses.spec.ts --runInBand --no-coverage
 */

import * as bitcoinjs from 'bitcoinjs-lib';

import { BlockpartyService } from './blockparty.service';
import { BlockpartyInvitationService } from './blockparty-invitation.service';
import { rpcCall, assembleWithMiningJobAndTemplate, NETWORK } from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf'; // P2WPKH pool fee
const ADDR_ADMIN = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq'; // P2WPKH admin

// ── Mock repo factory (mirror of blockparty-regtest.spec.ts) ──────────

function createMockRepo(target: string) {
    const rows = new Map<any, any>();
    let nextId = 1;

    function matchesWhere(row: any, where: any): boolean {
        return Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && '_type' in (v as any)) {
                if ((v as any)._type === 'isNull') return row[k] == null;
            }
            return row[k] === v;
        });
    }

    return {
        _rows: rows,
        target,
        save: jest.fn(async (row: any) => {
            if (target === 'invitation') {
                rows.set(row.token, { ...row });
                return { ...row };
            }
            if (target === 'history' && !row.id) {
                for (const existing of Array.from(rows.values())) {
                    if ((existing as any).groupId === row.groupId
                        && (existing as any).blockHash === row.blockHash) {
                        const err: any = new Error('duplicate key');
                        err.code = '23505';
                        throw err;
                    }
                }
            }
            if (!row.id) {
                row.id = target === 'group' ? `uuid-${nextId++}` : nextId++;
            }
            rows.set(row.id, { ...row });
            return { ...row };
        }),
        create: jest.fn((partial: any) => ({ ...partial })),
        find: jest.fn(async (query?: any) => {
            const all = Array.from(rows.values());
            let out = all;
            if (query?.where) {
                const where = Array.isArray(query.where) ? query.where : [query.where];
                out = all.filter(r => where.some((w: any) => matchesWhere(r, w)));
            }
            if (query?.order) {
                const [[k, dir]] = Object.entries(query.order);
                out = [...out].sort((a, b) => a[k] === b[k] ? 0 : (a[k] < b[k] ? (dir === 'DESC' ? 1 : -1) : (dir === 'DESC' ? -1 : 1)));
            }
            return out;
        }),
        findOne: jest.fn(async (query: any) => {
            return Array.from(rows.values()).find(r => matchesWhere(r, query?.where ?? {})) ?? null;
        }),
        findOneBy: jest.fn(async (where: any) => {
            return Array.from(rows.values()).find(r => matchesWhere(r, where)) ?? null;
        }),
        delete: jest.fn(async (where: any) => {
            for (const [id, row] of Array.from(rows.entries())) {
                if (matchesWhere(row, where)) rows.delete(id);
            }
        }),
        update: jest.fn(async (where: any, patch: any) => {
            let affected = 0;
            for (const row of Array.from(rows.values())) {
                if (matchesWhere(row, where)) {
                    Object.assign(row, patch);
                    affected++;
                }
            }
            return { affected };
        }),
    };
}

async function buildServices() {
    const groupRepo = createMockRepo('group');
    const memberRepo = createMockRepo('member');
    const historyRepo = createMockRepo('history');
    const invitationRepo = createMockRepo('invitation');

    const repoByTarget: Record<string, any> = {
        group: groupRepo, member: memberRepo, history: historyRepo, invitation: invitationRepo,
    };
    const manager = {
        transaction: jest.fn(async (cb: (em: any) => Promise<any>) => cb({
            getRepository: (target: string) => repoByTarget[target] ?? createMockRepo(target),
        })),
    };
    for (const r of [groupRepo, memberRepo, historyRepo, invitationRepo]) (r as any).manager = manager;

    const config = {
        get: (k: string) => ({
            PPLNS_FEE_ADDRESS: ADDR_FEE,
            PPLNS_FEE_PERCENT: '2',
            // Keep min-payout low so none of the 4 mid-sized member splits
            // get trimmed into the pool fee output — this spec is about
            // address-type encoding, not the dust path.
            PPLNS_MIN_PAYOUT_SATS: '5000',
        } as Record<string, string>)[k],
    };
    const groupService = { getGroupForAddress: () => undefined };
    const addressEmailService = {
        getVerified: async (address: string) => ({
            address, email: `${address}@verified.local`, verifiedAt: Date.now(),
            createdAt: Date.now(), updatedAt: Date.now(),
        }),
    };

    const blockparty = new BlockpartyService(
        groupRepo as any, memberRepo as any, historyRepo as any, config as any, groupService as any, addressEmailService as any,
    );
    await blockparty.onModuleInit();
    const emailService = { sendInvitation: jest.fn(async () => undefined) };
    const invitationConfig = { get: (k: string) => k === 'POOL_BASE_URL' ? 'https://pool.example' : undefined };
    const invitations = new BlockpartyInvitationService(
        invitationRepo as any, blockparty, emailService as any, invitationConfig as any,
    );
    return { blockparty, invitations, historyRepo };
}

/**
 * scriptPubKey-shape classifier for the on-chain coinbase outputs.
 * Matches Bitcoin's canonical templates as of v29:
 *   P2WPKH = OP_0 <20 bytes>      (length 22)
 *   P2WSH  = OP_0 <32 bytes>      (length 34)
 *   P2TR   = OP_1 <32 bytes>      (length 34)
 *   P2PKH  = OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG  (length 25)
 *   P2SH   = OP_HASH160 <20 bytes> OP_EQUAL  (length 23)
 *   OP_RETURN witness commit starts with 6a (length 38)
 */
function classifyScript(script: Buffer): string {
    if (script[0] === 0x6a) return 'OP_RETURN';
    if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh';
    if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return 'p2wsh';
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr';
    if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14
        && script[23] === 0x88 && script[24] === 0xac) return 'p2pkh';
    if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return 'p2sh';
    return `unknown(${script.length})`;
}

describe('Blockparty Regtest — mixed-address-type coinbase', () => {

    let bobP2pkh = '';
    let carolP2tr = '';
    let daveP2wpkh = '';

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
                // 'default' may exist on disk but be unloaded — load it; create only if absent.
                try { await rpcCall('loadwallet', ['default']); }
                catch { try { await rpcCall('createwallet', ['default']); } catch { /* race / already loaded */ } }
            }
            // BIP34 gate: coinbase scriptSig encodes heights 1..16 as OP_N,
            // which our builder doesn't emit. Mirror of blockparty-regtest.spec.ts.
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
            // Wallet-side address generation guarantees regtest-network-valid
            // bech32 / legacy strings without hard-coding network-specific
            // prefixes in the spec.
            bobP2pkh = await rpcCall('getnewaddress', ['', 'legacy']);
            carolP2tr = await rpcCall('getnewaddress', ['', 'bech32m']);
            daveP2wpkh = await rpcCall('getnewaddress', ['', 'bech32']);
        } catch (e: any) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443: ${e?.message ?? e}`);
        }
    });

    it('mints valid coinbase with P2WPKH-Admin + P2PKH-Bob + P2TR-Carol + P2WPKH-Dave and Core 29 accepts the block', async () => {
        const { blockparty } = await buildServices();

        // Splits sum to 10000 = 100% of the miner cut:
        //   admin 4000 (40%) + bob 2500 + carol 2000 + dave 1500
        // The pool fee (2%) comes off the top before splits are applied.
        const created = await blockparty.createGroup({
            name: 'mixed-addr-regtest',
            adminAddress: ADDR_ADMIN,
            adminEmail: 'admin@test.local',
            adminPercentBp: 4000,
        });
        await blockparty.addMember(created.group.id, {
            address: bobP2pkh, email: 'bob@test.local', percentBp: 2500,
        }, created.adminToken);
        await blockparty.addMember(created.group.id, {
            address: carolP2tr, email: 'carol@test.local', percentBp: 2000,
        }, created.adminToken);
        await blockparty.addMember(created.group.id, {
            address: daveP2wpkh, email: 'dave@test.local', percentBp: 1500,
        }, created.adminToken);

        // Bring the party from CONFIRMING up to ACTIVE so the routing
        // path would accept it; not strictly required for the coinbase
        // construction but keeps the spec end-to-end realistic.
        await blockparty.markMemberConfirmed(created.group.id, bobP2pkh);
        await blockparty.markMemberConfirmed(created.group.id, carolP2tr);
        await blockparty.markMemberConfirmed(created.group.id, daveP2wpkh);
        await blockparty.transitionToConfirming(created.group.id, created.adminToken);
        await blockparty.onShareAccepted(ADDR_ADMIN);

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const reward = template.coinbasevalue;
        const distribution = await blockparty.getPayoutDistribution(created.group.id, reward);

        // Five payout entries: pool fee + 4 members. None trimmed (min-payout = 5000
        // sats, lowest split is dave at 1500bp of a 9800bp miner-cut on a 5+ BTC reward).
        expect(distribution.payouts).toHaveLength(5);
        expect(distribution.splits.every(s => !s.trimmed)).toBe(true);
        const totalSats = distribution.payouts.reduce((s, p) => s + p.sats, 0);
        expect(totalSats).toBe(reward);

        // Build + submit the block via the production MiningJob path.
        const mjDist = distribution.payouts.map(p => ({ address: p.address, percent: p.percent }));
        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(mjDist, template, 'bp-mixed');
        expect(submitResult).toBeNull(); // Core acceptance

        // Coinbase output sum equals the block reward exactly (rounding
        // remainder gets folded into outs[0], which for Blockparty is the
        // pool fee output).
        const coinbaseTotal = coinbaseTx.outs.reduce((s: number, o: any) => s + o.value, 0);
        expect(coinbaseTotal).toBe(reward);

        // Per-output scriptPubKey shape — each address type must encode
        // to its canonical template, NOT the wrong type or an empty
        // script (which would be the failure mode if MiningJob's
        // getPaymentScript default branch fired).
        const shapes = coinbaseTx.outs.map((o: any) => classifyScript(Buffer.from(o.script)));
        // outs ordering: [pool fee (p2wpkh), admin (p2wpkh), bob (p2pkh),
        //                 carol (p2tr), dave (p2wpkh), OP_RETURN segwit commit]
        expect(shapes[0]).toBe('p2wpkh'); // pool fee
        expect(shapes[1]).toBe('p2wpkh'); // admin
        expect(shapes[2]).toBe('p2pkh');  // bob
        expect(shapes[3]).toBe('p2tr');   // carol
        expect(shapes[4]).toBe('p2wpkh'); // dave
        expect(shapes[5]).toBe('OP_RETURN'); // segwit commitment

        // Address → scriptPubKey round-trip: derive the expected script
        // from each address and assert it matches what landed in the
        // coinbase. Guards against the "right shape, wrong key" failure
        // where MiningJob picked a default branch or used a stale
        // network.
        const expectedScripts: Record<string, Buffer> = {
            [ADDR_FEE]: bitcoinjs.payments.p2wpkh({ address: ADDR_FEE, network: NETWORK }).output!,
            [ADDR_ADMIN]: bitcoinjs.payments.p2wpkh({ address: ADDR_ADMIN, network: NETWORK }).output!,
            [bobP2pkh]: bitcoinjs.payments.p2pkh({ address: bobP2pkh, network: NETWORK }).output!,
            [carolP2tr]: bitcoinjs.payments.p2tr({ address: carolP2tr, network: NETWORK }).output!,
            [daveP2wpkh]: bitcoinjs.payments.p2wpkh({ address: daveP2wpkh, network: NETWORK }).output!,
        };
        for (let i = 0; i < distribution.payouts.length; i++) {
            const payout = distribution.payouts[i];
            const got = Buffer.from(coinbaseTx.outs[i].script);
            expect(got.equals(expectedScripts[payout.address])).toBe(true);
        }

        // Per-output sat values — MiningJob computes amount = floor(percent/100 * reward)
        // and folds the rounding remainder back into outs[0] (= the pool fee
        // for Blockparty). So member outputs (outs[1..]) must equal their
        // distribution.payouts[i].sats exactly; outs[0] is allowed to be
        // ≥ distribution.payouts[0].sats by the rounding remainder.
        const memberSatsByAddress = new Map<string, number>();
        for (const p of distribution.payouts) memberSatsByAddress.set(p.address, p.sats);
        for (let i = 1; i < distribution.payouts.length; i++) {
            const payout = distribution.payouts[i];
            expect(coinbaseTx.outs[i].value).toBe(payout.sats);
        }
        // outs[0] catches the floor-remainder. Distribution sums to reward, so
        // the on-chain pool fee output equals the distribution's pool fee output
        // value (no drift between MiningJob and BlockpartyDistribution at this
        // reward magnitude on regtest).
        expect(coinbaseTx.outs[0].value).toBe(distribution.payouts[0].sats);

        const info = await rpcCall('getblockchaininfo');
        expect(info.blocks).toBe(template.height);

        console.log(`\n=== Blockparty Mixed-Address Regtest ===`);
        console.log(`Height: ${template.height}, reward: ${reward} sats, pool fee: ${distribution.poolFeeSats} sats`);
        console.log(`Output shapes: ${shapes.join(' / ')}`);
        console.log(`Addresses:`);
        console.log(`  fee   (p2wpkh): ${ADDR_FEE}  → ${distribution.payouts[0].sats} sats`);
        console.log(`  admin (p2wpkh): ${ADDR_ADMIN} → ${distribution.payouts[1].sats} sats`);
        console.log(`  bob   (p2pkh):  ${bobP2pkh} → ${distribution.payouts[2].sats} sats`);
        console.log(`  carol (p2tr):   ${carolP2tr} → ${distribution.payouts[3].sats} sats`);
        console.log(`  dave  (p2wpkh): ${daveP2wpkh} → ${distribution.payouts[4].sats} sats`);
        console.log('✅ Mixed-address coinbase accepted by Bitcoin Core 29');
    }, 60000);
});
