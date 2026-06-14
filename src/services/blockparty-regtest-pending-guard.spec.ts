/**
 * Blockparty Regtest — pending-party fee-routing guard
 *
 * Closes the "premature rental" hole: when an admin's address belongs
 * to a Blockparty that hasn't reached READY yet (some members still
 * need to confirm their splits), block-found shares MUST NOT pay the
 * admin a 100 % Solo coinbase. The defensive Stratum branch instead
 * routes the entire block reward to the pool-fee address via
 * BlockpartyService.getPendingPartyFeeRoute().
 *
 * This spec verifies the on-chain shape end-to-end: build a real
 * coinbase via the production MiningJob path with the pending-route
 * output set, submit to Bitcoin Core 29, expect acceptance + single
 * fee-address output carrying the full reward.
 *
 * Run: npx jest src/services/blockparty-regtest-pending-guard.spec.ts --runInBand --no-coverage
 */

import { BlockpartyService } from './blockparty.service';
import { rpcCall, assembleWithMiningJobAndTemplate } from './__test-helpers__/regtest-harness';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf';
const ADDR_ADMIN = 'bcrt1q2jf90sp25mt4pte5swkr4cujpj5d8zzwdt09fq';
const ADDR_BOB = 'bcrt1qt2amqww2n3dcz3ckx6nlentvm9e6rpxqrfmvl7';

// Mock-repo factory mirroring blockparty-regtest.spec.ts. Trimmed to
// the entities this spec touches.
function createMockRepo(target: string) {
    const rows = new Map<any, any>();
    let nextId = 1;

    function matchesWhere(row: any, where: any): boolean {
        return Object.entries(where).every(([k, v]) => row[k] === v);
    }

    return {
        _rows: rows,
        target,
        save: jest.fn(async (row: any) => {
            if (!row.id) row.id = target === 'group' ? `uuid-${nextId++}` : nextId++;
            rows.set(row.id, { ...row });
            return { ...row };
        }),
        create: jest.fn((partial: any) => ({ ...partial })),
        find: jest.fn(async (query?: any) => {
            const all = Array.from(rows.values());
            if (!query?.where) return all;
            const where = Array.isArray(query.where) ? query.where : [query.where];
            return all.filter(r => where.some((w: any) => matchesWhere(r, w)));
        }),
        findOne: jest.fn(async (query: any) => {
            return Array.from(rows.values()).find(r => matchesWhere(r, query?.where ?? {})) ?? null;
        }),
        findOneBy: jest.fn(async (where: any) => {
            return Array.from(rows.values()).find(r => matchesWhere(r, where)) ?? null;
        }),
        delete: jest.fn(async () => undefined),
        update: jest.fn(async () => ({ affected: 0 })),
    };
}

async function buildService() {
    const groupRepo = createMockRepo('group');
    const memberRepo = createMockRepo('member');
    const historyRepo = createMockRepo('history');
    const manager = {
        transaction: jest.fn(async (cb: (em: any) => Promise<any>) => cb({
            getRepository: () => createMockRepo('inner'),
        })),
    };
    for (const r of [groupRepo, memberRepo, historyRepo]) (r as any).manager = manager;

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

    const service = new BlockpartyService(
        groupRepo as any, memberRepo as any, historyRepo as any,
        config as any, groupService as any, addressEmailService as any,
    );
    await service.onModuleInit();
    return service;
}

describe('Blockparty Regtest — pending-party fee-route guard', () => {

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
            // BIP34 gate (heights 1..16 encode as OP_N).
            if (info.blocks < 17) {
                const addr = await rpcCall('getnewaddress');
                await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
            }
        } catch (e: any) {
            throw new Error(`Bitcoin Core regtest not running at localhost:18443: ${e?.message ?? e}`);
        }
    });

    it('CONFIRMING party: admin address routes the block to the pool fee, Core accepts', async () => {
        const service = await buildService();

        // 1. Create the party (admin = Bob's invite hasn't been confirmed yet).
        //    addMember auto-flips DRAFT → CONFIRMING.
        const { group, adminToken } = await service.createGroup({
            name: 'pending-regtest', adminAddress: ADDR_ADMIN, adminEmail: 'admin@test.local', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: ADDR_BOB, email: 'bob@test.local', percentBp: 5000,
        }, adminToken);

        // 2. Defensive contract: routing layer must NOT route to a
        //    Blockparty coinbase while members are unconfirmed.
        expect(service.getRoutableGroupIdForAdmin(ADDR_ADMIN)).toBeUndefined();

        // 3. Pending-party guard returns the fee-only override that the
        //    Stratum solo-fallback applies.
        const pendingRoute = service.getPendingPartyFeeRoute(ADDR_ADMIN);
        expect(pendingRoute).toEqual([{ address: ADDR_FEE, percent: 100 }]);

        // 4. Build + submit a real block via the production MiningJob path
        //    using that fee-only payout list. Core 29 must accept it.
        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(
            pendingRoute!,
            template,
            'bp-pending-fee',
        );
        expect(submitResult).toBeNull(); // null = Core acceptance

        // 5. Block reward landed entirely on the fee address — no admin
        //    output, no leak. Coinbase has 2 outs: [0] = fee (100 %),
        //    [1] = OP_RETURN segwit-commit. Sat conservation exact.
        expect(coinbaseTx.outs.length).toBe(2);
        const feeOut = coinbaseTx.outs[0];
        expect(feeOut.value).toBe(template.coinbasevalue);
        // outs[1] is the witness-commitment OP_RETURN — value 0.
        expect(coinbaseTx.outs[1].value).toBe(0);
        expect(Buffer.from(coinbaseTx.outs[1].script)[0]).toBe(0x6a);

        // 6. Chain tip advanced.
        const info = await rpcCall('getblockchaininfo');
        expect(info.blocks).toBe(template.height);

        console.log(`\n=== Pending-Guard Regtest ===`);
        console.log(`Party "${group.name}" status: ${group.status}, members confirmed: 1/2 (admin auto-confirmed; Bob still pending)`);
        console.log(`Height: ${template.height}, reward: ${template.coinbasevalue} sats → 100 % to ${ADDR_FEE}`);
        console.log('✅ Pending-party admin coinbase routed entirely to pool fee, accepted by Core 29');
    }, 60000);

    it('READY party: pending-route returns null, regular Blockparty routing engages', async () => {
        const service = await buildService();

        const { group, adminToken } = await service.createGroup({
            name: 'ready-regtest', adminAddress: ADDR_ADMIN, adminEmail: 'admin@test.local', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: ADDR_BOB, email: 'bob@test.local', percentBp: 5000,
        }, adminToken);
        // Bob confirms → CONFIRMING flips to READY via recomputeStatus.
        await service.markMemberConfirmed(group.id, ADDR_BOB);

        const saved = (service as any).groupRepo.findOneBy
            ? await (service as any).groupRepo.findOneBy({ id: group.id })
            : null;
        // Verify status flipped, defending against the cache-sync
        // regression: routing AND pending-route both rely on the
        // in-memory adminAddressCache being updated when status
        // changes outside onShareAccepted.
        expect(saved?.status).toBe('ready');
        expect(service.getRoutableGroupIdForAdmin(ADDR_ADMIN)).toBe(group.id);
        expect(service.getPendingPartyFeeRoute(ADDR_ADMIN)).toBeNull();
    }, 30000);
});
