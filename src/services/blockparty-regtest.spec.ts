/**
 * Blockparty Regtest Integration Test
 *
 * End-to-end: BlockpartyService builds a multi-output coinbase from the
 * configured per-member basis-point splits, MiningJob assembles a real
 * block via the production path, Bitcoin Core regtest accepts it.
 * Also exercises the full state machine
 * (DRAFT → CONFIRMING → READY → ACTIVE) plus the dissolve 7-day cooldown.
 *
 * Requires a running regtest node at localhost:18443 (rpcuser=test,
 * rpcpassword=test). Mirror of group-solo-regtest.spec.ts.
 *
 * Run: npx jest blockparty-regtest --runInBand --no-coverage
 */

import { BlockpartyService } from './blockparty.service';
import { BlockpartyInvitationService } from './blockparty-invitation.service';
import { rpcCall, assembleWithMiningJobAndTemplate } from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ADMIN = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';

// ── Mock repo factory (token-keyed for invitations, generic otherwise) ──

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
            // Simulate the (groupId, blockHash) unique index on the history table
            // so the production 23505-catch path is exercised by replays.
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
    return { blockparty, invitations, groupRepo, memberRepo, historyRepo, invitationRepo };
}

describe('Blockparty Regtest — End-to-End with Bitcoin Core', () => {

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
            // BIP34 coinbase scriptSig — same reason as the group-solo regtest:
            // heights 1..16 encode as OP_N, which our coinbase builder doesn't emit.
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch {
            throw new Error('Bitcoin Core regtest not running at localhost:18443. Start with: bitcoind -regtest -daemon -rpcuser=test -rpcpassword=test -rpcport=18443');
        }
    });

    it('full lifecycle: create → invite → confirm → first share activates → block submit accepted by Core → onBlockFound writes history', async () => {
        const { blockparty, invitations, historyRepo } = await buildServices();

        // 1. Admin creates a draft Blockparty (admin keeps 49 % of the miner cut).
        const created = await blockparty.createGroup({
            name: 'rental-regtest', adminAddress: ADDR_ADMIN, adminEmail: 'admin@test.local', adminPercentBp: 5000,
        });
        expect(created.group.status).toBe('draft');

        // 2. Admin adds Bob (49 %, sum = 9800 = 100 % − 2 % pool fee).
        const bob = await blockparty.addMember(created.group.id, {
            address: ADDR_BOB, email: 'bob@test.local', percentBp: 5000,
        }, created.adminToken);
        expect(bob.confirmedAt).toBeNull();

        // 3. Bob gets an invitation token, accepts it via the public invite flow.
        const invite = await invitations.createInvitation({
            groupId: created.group.id, address: ADDR_BOB, email: 'bob@test.local',
        });
        await invitations.accept(invite.token);

        // 4. Admin transitions to CONFIRMING (validates the splits sum).
        //    Bob's prior accept means recomputeStatus → 'ready' immediately.
        await blockparty.transitionToConfirming(created.group.id, created.adminToken);
        let group = await blockparty.getGroup(created.group.id);
        expect(group?.status).toBe('ready');

        // 5. First share lands on the admin's treasury address → state → ACTIVE.
        await blockparty.onShareAccepted(ADDR_ADMIN);
        group = await blockparty.getGroup(created.group.id);
        expect(group?.status).toBe('active');
        expect(group?.lastShareAt).toBeGreaterThan(0);

        // 6. Fetch a real Core block template; compute the on-chain split.
        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const blockReward = template.coinbasevalue;
        const height = template.height;

        const distribution = await blockparty.getPayoutDistribution(created.group.id, blockReward);

        // Three outputs expected: pool fee + admin share + Bob share.
        const addresses = distribution.payouts.map(p => p.address);
        expect(addresses).toContain(ADDR_FEE);
        expect(addresses).toContain(ADDR_ADMIN);
        expect(addresses).toContain(ADDR_BOB);
        expect(distribution.payouts.length).toBe(3);

        // Sat conservation: pool fee + paid members === blockReward.
        const totalSats = distribution.payouts.reduce((s, p) => s + p.sats, 0);
        expect(totalSats).toBe(blockReward);

        console.log(`\n=== Blockparty Regtest ===`);
        console.log(`Height: ${height}`);
        console.log(`Block reward: ${blockReward} sats, pool fee: ${distribution.poolFeeSats} sats`);
        console.log(`Outputs: ${distribution.payouts.map(p => `${p.address.slice(0, 12)}…=${p.sats}`).join(', ')}`);

        // 7. Build + submit a real block via the production MiningJob path.
        const mjDist = distribution.payouts.map(p => ({ address: p.address, percent: p.percent }));
        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(mjDist, template, 'bp-basic');
        expect(submitResult).toBeNull(); // null = accepted

        // Coinbase total on-chain must match blockReward exactly.
        const coinbaseTotal = coinbaseTx.outs.reduce((s: number, o: any) => s + o.value, 0);
        expect(coinbaseTotal).toBe(blockReward);

        // Chain tip advanced.
        const info = await rpcCall('getblockchaininfo');
        expect(info.blocks).toBe(height);

        // 8. onBlockFound writes a history row that mirrors the on-chain split.
        const blockHash = info.bestblockhash;
        await blockparty.onBlockFound({
            groupId: created.group.id,
            blockHeight: height,
            blockHash,
            coinbaseValueSats: blockReward,
        });
        const history = await blockparty.getHistory(created.group.id);
        expect(history).toHaveLength(1);
        expect(history[0].blockHeight).toBe(height);
        expect(history[0].blockHash).toBe(blockHash);
        expect(history[0].coinbaseValueSats).toBe(blockReward);
        expect(history[0].poolFeeSats).toBe(distribution.poolFeeSats);
        expect(history[0].splits).toHaveLength(2); // admin + bob (no trimmed)
        expect(history[0].splits.every((s: any) => !s.trimmed)).toBe(true);

        // Idempotent replay — second call must not write a duplicate row.
        const replay = await blockparty.onBlockFound({
            groupId: created.group.id,
            blockHeight: height,
            blockHash,
            coinbaseValueSats: blockReward,
        });
        expect(replay).toBeNull();
        expect((historyRepo as any)._rows.size).toBe(1);

        // Party is still ACTIVE after the block — Blockparty has no per-block
        // dissolve (the rental runs until admin explicitly tears it down).
        group = await blockparty.getGroup(created.group.id);
        expect(group?.status).toBe('active');

        console.log('✅ Lifecycle verified: state machine → on-chain coinbase → history idempotency');
    }, 60000);

    it('dissolve respects the 7-day post-share cooldown', async () => {
        const { blockparty, groupRepo } = await buildServices();
        const created = await blockparty.createGroup({
            name: 'cooldown-regtest', adminAddress: ADDR_ADMIN, adminEmail: 'admin@test.local', adminPercentBp: 5000,
        });
        await blockparty.addMember(created.group.id, {
            address: ADDR_BOB, email: 'bob@test.local', percentBp: 5000,
        }, created.adminToken);
        await blockparty.transitionToConfirming(created.group.id, created.adminToken);
        await blockparty.markMemberConfirmed(created.group.id, ADDR_BOB);

        // First share — flips status to ACTIVE and sets lastShareAt = now.
        await blockparty.onShareAccepted(ADDR_ADMIN);
        let group = await blockparty.getGroup(created.group.id);
        expect(group?.status).toBe('active');

        // Attempt dissolve during the cooldown → 'dissolve-cooldown'.
        await expect(
            blockparty.dissolveGroup(created.group.id, created.adminToken),
        ).rejects.toMatchObject({ code: 'dissolve-cooldown' });

        // Backdate lastShareAt by 25h on the mocked row, retry — must succeed.
        const stored = (groupRepo as any)._rows.get(created.group.id);
        stored.lastShareAt = Date.now() - 8 * 24 * 60 * 60 * 1000;

        await blockparty.dissolveGroup(created.group.id, created.adminToken);
        group = await blockparty.getGroup(created.group.id);
        expect(group?.status).toBe('dissolved');
        expect(group?.dissolvedAt).toBeGreaterThan(0);
    }, 30000);
});
