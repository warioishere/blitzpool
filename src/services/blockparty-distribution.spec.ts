import { buildBlockpartyDistribution } from './blockparty-distribution';
import { DUST_LIMIT_SATS } from './coinbase-distribution';

const FEE_ADDR = 'bc1qfeeaddress';
const A = 'bc1qaaaaa';
const B = 'bc1qbbbbb';
const C = 'bc1qccccc';

describe('buildBlockpartyDistribution', () => {

    it('returns empty when reward is 0', () => {
        const r = buildBlockpartyDistribution({
            members: [{ address: A, percentBp: 10000 }],
            blockRewardSats: 0,
            poolFeeAddress: FEE_ADDR,
            poolFeePercent: 2,
            minPayoutSats: 5_000,
        });
        expect(r.splits).toEqual([]);
        expect(r.poolFeeSats).toBe(0);
        expect(r.payouts).toEqual([]);
    });

    it('routes the entire reward to pool-fee when there are no members', () => {
        const reward = 312_500_000;
        const r = buildBlockpartyDistribution({
            members: [],
            blockRewardSats: reward,
            poolFeeAddress: FEE_ADDR,
            poolFeePercent: 2,
            minPayoutSats: 5_000,
        });
        expect(r.poolFeeSats).toBe(reward);
        expect(r.payouts).toHaveLength(1);
        expect(r.payouts[0]).toMatchObject({ address: FEE_ADDR, sats: reward });
    });

    it('splits miner cut by basis points and balances against pool fee', () => {
        const reward = 312_500_000; // 3.125 BTC
        const r = buildBlockpartyDistribution({
            members: [
                { address: A, percentBp: 5000 }, // 50% of miner cut
                { address: B, percentBp: 3000 }, // 30%
                { address: C, percentBp: 2000 }, // 20%
            ],
            blockRewardSats: reward,
            poolFeeAddress: FEE_ADDR,
            poolFeePercent: 2,
            minPayoutSats: 5_000,
        });

        const basePoolFee = Math.floor(reward * 0.02);
        const minerCut = reward - basePoolFee;
        const expectA = Math.floor(minerCut * 0.5);
        const expectB = Math.floor(minerCut * 0.3);
        const expectC = Math.floor(minerCut * 0.2);

        expect(r.splits.map(s => ({ address: s.address, sats: s.sats, trimmed: s.trimmed }))).toEqual([
            { address: A, sats: expectA, trimmed: false },
            { address: B, sats: expectB, trimmed: false },
            { address: C, sats: expectC, trimmed: false },
        ]);

        // Outputs must sum to exactly reward — rounding leftover goes to pool fee.
        const totalOut = r.payouts.reduce((acc, p) => acc + p.sats, 0);
        expect(totalOut).toBe(reward);
        expect(r.poolFeeSats).toBe(reward - (expectA + expectB + expectC));
    });

    it('rolls sub-min-payout members into the pool fee with trimmed=true', () => {
        // 0.01% of 312.5M sats minerCut = 30625 sats — above min — pick a smaller reward.
        // 1% of 100000 (after 2% fee = 98000 minerCut) = 980 sats < 5000.
        const reward = 100_000;
        const r = buildBlockpartyDistribution({
            members: [
                { address: A, percentBp: 9900 }, // 99% — well above min
                { address: B, percentBp: 100 },  // 1% → 980 sats < 5000 → trimmed
            ],
            blockRewardSats: reward,
            poolFeeAddress: FEE_ADDR,
            poolFeePercent: 2,
            minPayoutSats: 5_000,
        });

        expect(r.splits[1]).toMatchObject({ address: B, sats: 0, trimmed: true });
        expect(r.splits[0].trimmed).toBe(false);
        // B's 980 sats roll into pool fee — pool fee > base fee of 2000.
        expect(r.poolFeeSats).toBeGreaterThan(Math.floor(reward * 0.02));
        // Conservation: outputs sum to exactly reward.
        const totalOut = r.payouts.reduce((acc, p) => acc + p.sats, 0);
        expect(totalOut).toBe(reward);
    });

    it('uses DUST_LIMIT_SATS as the effective floor even when minPayoutSats is lower', () => {
        // minPayoutSats=100 but DUST_LIMIT_SATS=546. A 500-sat member output
        // must still be trimmed because Bitcoin core relay-policy would
        // reject it as dust.
        // 1% of 50000 minerCut after 2% fee (49000) = 490 sats < 546.
        const reward = 50_000;
        const r = buildBlockpartyDistribution({
            members: [
                { address: A, percentBp: 9900 },
                { address: B, percentBp: 100 },
            ],
            blockRewardSats: reward,
            poolFeeAddress: FEE_ADDR,
            poolFeePercent: 2,
            minPayoutSats: 100, // intentionally below DUST_LIMIT_SATS
        });
        expect(r.splits[1].trimmed).toBe(true);
        expect(DUST_LIMIT_SATS).toBe(546); // documentation: link this expectation to the constant
    });

    it('skips the pool-fee output when poolFeeAddress is empty', () => {
        const reward = 312_500_000;
        const r = buildBlockpartyDistribution({
            members: [{ address: A, percentBp: 10000 }],
            blockRewardSats: reward,
            poolFeeAddress: '',
            poolFeePercent: 2,
            minPayoutSats: 5_000,
        });
        // Pool-fee sats are still computed and conserved, but no output is
        // emitted to an empty address (caller decides how to handle).
        expect(r.payouts.find(p => p.address === '')).toBeUndefined();
        expect(r.payouts.map(p => p.address)).toEqual([A]);
    });

    it('conserves total sats: every output sums to reward', () => {
        const cases = [
            { reward: 312_500_000, feePct: 2 },
            { reward: 156_250_000, feePct: 1.5 },
            { reward: 78_125_000, feePct: 0 },
            { reward: 1_000_000_000, feePct: 5 },
        ];
        for (const { reward, feePct } of cases) {
            const r = buildBlockpartyDistribution({
                members: [
                    { address: A, percentBp: 3333 },
                    { address: B, percentBp: 3333 },
                    { address: C, percentBp: 3334 },
                ],
                blockRewardSats: reward,
                poolFeeAddress: FEE_ADDR,
                poolFeePercent: feePct,
                minPayoutSats: 5_000,
            });
            const totalOut = r.payouts.reduce((acc, p) => acc + p.sats, 0);
            expect(totalOut).toBe(reward);
        }
    });
});
