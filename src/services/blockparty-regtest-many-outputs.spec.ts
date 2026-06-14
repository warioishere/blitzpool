/**
 * High-output-count Blockparty regtest: builds a 50-member coinbase (51
 * outputs incl. pool fee) of mixed address types via the production MiningJob
 * path and verifies Bitcoin Core regtest ACCEPTS the block. Directly mirrors a
 * large real Blockparty (dozens of renters) — the scenario the operator was
 * worried about. Requires a running regtest node at localhost:18443.
 */
import { rpcCall, assembleWithMiningJobAndTemplate } from './__test-helpers__/regtest-harness';
import { buildBlockpartyDistribution } from './blockparty-distribution';

const ADDR_FEE = 'bcrt1qqj0r5w2ua3pe0sh6gthvfeegvwsa3t4edumqzf'; // P2WPKH pool fee

const MEMBER_COUNT = 50;

describe('Blockparty Regtest — 50-member coinbase accepted by Core', () => {
    beforeAll(async () => {
        const info = await rpcCall('getblockchaininfo');
        expect(info.chain).toBe('regtest');
        const wallets: string[] = await rpcCall('listwallets');
        if (!wallets.includes('default')) {
            try { await rpcCall('loadwallet', ['default']); }
            catch { try { await rpcCall('createwallet', ['default']); } catch { /* race */ } }
        }
        if (info.blocks < 17) {
            const addr = await rpcCall('getnewaddress');
            await rpcCall('generatetoaddress', [17 - info.blocks, addr]);
        }
    });

    it(`mints a ${MEMBER_COUNT}-member mixed-type coinbase and Core accepts the block`, async () => {
        // 50 real regtest addresses, cycling P2PKH / P2TR / P2WPKH.
        const members: { address: string; percentBp: number }[] = [];
        for (let i = 0; i < MEMBER_COUNT; i++) {
            const type = i % 3 === 0 ? 'legacy' : i % 3 === 1 ? 'bech32m' : 'bech32';
            const address = await rpcCall('getnewaddress', ['', type]);
            members.push({ address, percentBp: 10000 / MEMBER_COUNT }); // 50 × 200 = 10000 (100%)
        }

        const template = await rpcCall('getblocktemplate', [{ rules: ['segwit'] }]);
        const reward = template.coinbasevalue;

        const distribution = buildBlockpartyDistribution({
            members,
            blockRewardSats: reward,
            poolFeeAddress: ADDR_FEE,
            poolFeePercent: 2,
            minPayoutSats: 5000,
        });

        // 51 outputs (fee + 50 members), none trimmed (each ~2% of a multi-BTC reward).
        expect(distribution.payouts.length).toBe(MEMBER_COUNT + 1);
        expect(distribution.splits.every(s => !s.trimmed)).toBe(true);

        // Sat conservation: outputs sum EXACTLY to the block reward.
        const totalSats = distribution.payouts.reduce((s, p) => s + p.sats, 0);
        expect(totalSats).toBe(reward);

        // Build + submit the block via the exact Stratum V1 production path.
        const mjDist = distribution.payouts.map(p => ({ address: p.address, percent: p.percent }));
        const { submitResult, coinbaseTx } = await assembleWithMiningJobAndTemplate(mjDist, template, 'bp-50');

        expect(submitResult).toBeNull(); // null = Core accepted the block

        // On-chain coinbase sums to the reward too (no bad-cb-amount).
        const coinbaseTotal = coinbaseTx.outs.reduce((s, o) => s + o.value, 0);
        expect(coinbaseTotal).toBe(reward);
        // 51 payout outputs + 1 witness-commitment OP_RETURN output.
        expect(coinbaseTx.outs.length).toBe(MEMBER_COUNT + 2);

        console.log(`✅ ${MEMBER_COUNT}-member coinbase (${coinbaseTx.outs.length} outputs incl. witness commitment) accepted by Core, ${coinbaseTotal} sats == reward`);
    });
});
