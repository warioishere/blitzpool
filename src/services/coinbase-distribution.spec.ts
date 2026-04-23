import {
    buildCoinbaseDistribution,
    DUST_LIMIT_SATS,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
} from './coinbase-distribution';

const FEE_ADDR = 'bc1qfee';
const ALICE = 'bc1qalice';
const BOB = 'bc1qbob';
const CHARLIE = 'bc1qcharlie';

function shares(obj: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(obj));
}

function sumSatsFromPayouts(payouts: { address: string; percent: number }[], reward: number): number {
    return payouts.reduce((s, p) => s + Math.floor((p.percent / 100) * reward), 0);
}

describe('buildCoinbaseDistribution', () => {

    // ── Basic ─────────────────────────────────────────────────

    it('no shares + no fee → empty payouts', () => {
        const r = buildCoinbaseDistribution({
            addressShares: new Map(),
            pendingBalances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: '',
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toEqual([]);
        expect(r.totalPendingSettled).toBe(0);
    });

    it('no shares + fee configured → 100 % to fee', () => {
        const r = buildCoinbaseDistribution({
            addressShares: new Map(),
            pendingBalances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toEqual([{ address: FEE_ADDR, percent: 100 }]);
    });

    it('two miners equal shares, no pending, 2 % fee → ~49/49/2', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            pendingBalances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toHaveLength(3);
        expect(r.payouts[0].address).toBe(FEE_ADDR);
        const [fee, a, b] = r.payouts;
        // Fee ≥ 2 % (absorbs rounding remainder)
        expect(fee.percent).toBeGreaterThanOrEqual(2);
        // Alice and Bob roughly 49 % each
        expect(a.percent).toBeCloseTo(49, 1);
        expect(b.percent).toBeCloseTo(49, 1);
    });

    // ── Invariant: outputs sum ≤ blockReward (the bad-cb-amount bug) ──

    it('pending balance is settled OUT OF miner cut, not on top of it', () => {
        // Without the fix: alice_sats + bob_sats + fee_sats = blockReward + 10_000
        // With the fix:    alice_sats + bob_sats + fee_sats ≈ blockReward
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            pendingBalances: new Map([[CHARLIE, 10_000]]),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const totalSats = sumSatsFromPayouts(r.payouts, reward);
        expect(totalSats).toBeLessThanOrEqual(reward);
        // And sum of percents should be ≤ 100 (strictly, since floor() rounds down)
        const totalPct = r.payouts.reduce((s, p) => s + p.percent, 0);
        expect(totalPct).toBeLessThanOrEqual(100.001);
    });

    it('many miners with various pendings → total never exceeds blockReward', () => {
        const reward = 5_000_000_000;
        const sharesIn: Record<string, number> = {};
        const pending = new Map<string, number>();
        for (let i = 0; i < 20; i++) {
            sharesIn[`bc1qaddr${i}`] = 100 + i * 5;
            pending.set(`bc1qaddr${i}`, 1000 + i * 100); // big pending
        }
        const r = buildCoinbaseDistribution({
            addressShares: shares(sharesIn),
            pendingBalances: pending,
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const totalSats = sumSatsFromPayouts(r.payouts, reward);
        expect(totalSats).toBeLessThanOrEqual(reward);
    });

    // ── Pending-only miners ───────────────────────────────────

    it('miner with only pending (no shares this round) ≥ dust → included', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            pendingBalances: new Map([[CHARLIE, 50_000]]),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const addrs = r.payouts.map(p => p.address);
        expect(addrs).toContain(CHARLIE);
    });

    it('miner with only pending but < dust → NOT in coinbase', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            pendingBalances: new Map([[CHARLIE, 100]]), // < 546
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const addrs = r.payouts.map(p => p.address);
        expect(addrs).not.toContain(CHARLIE);
    });

    // ── Dust gates ────────────────────────────────────────────

    it('tiny fee percent → fee output is dust → fee omitted, remainder sweeps to miner', () => {
        // On a 5 BTC regtest block, 0.00001 % = 500 sats < dust.
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            pendingBalances: new Map(),
            blockRewardSats: reward,
            feePercent: 0.00001,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const addrs = r.payouts.map(p => p.address);
        expect(addrs).not.toContain(FEE_ADDR);
        expect(addrs).toEqual([ALICE]);
        const totalPct = r.payouts.reduce((s, p) => s + p.percent, 0);
        expect(totalPct).toBeCloseTo(100, 3);
    });

    it('sub-dust miner is filtered out of coinbase', () => {
        // Alice gets most of the share → Bob's cut falls below dust.
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 1_000_000_000, [BOB]: 1 }),
            pendingBalances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const addrs = r.payouts.map(p => p.address);
        expect(addrs).not.toContain(BOB);
    });

    // ── Weight-budget trim ────────────────────────────────────

    it('trims smallest miners when budget cannot fit all outputs', () => {
        // 50 eligible outputs but budget = 1500 WU → fits only ~4 outputs.
        const addressShares = new Map<string, number>();
        const reward = 5_000_000_000;
        // Give each miner enough share to clear dust
        for (let i = 0; i < 50; i++) {
            // Decreasing shares so smallest ones get trimmed
            addressShares.set(`bc1qaddr${i}`, 100_000 - i * 1000);
        }
        const r = buildCoinbaseDistribution({
            addressShares,
            pendingBalances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: 1500, // very tight
        });
        // budget 1500 - 320 base - 188 witness - 172 fee output = 820 / 172 = 4 miner outputs
        const minerOutputs = r.payouts.filter(p => p.address !== FEE_ADDR);
        expect(minerOutputs.length).toBe(4);
        // Kept ones should be the LARGEST shares (addr0..addr3).
        const kept = minerOutputs.map(p => p.address).sort();
        expect(kept).toEqual(['bc1qaddr0', 'bc1qaddr1', 'bc1qaddr2', 'bc1qaddr3']);
    });

    // ── considered + settled bookkeeping ──────────────────────

    it('consideredAddresses captures everyone in shares + everyone in pending', () => {
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            pendingBalances: new Map([[BOB, 100], [CHARLIE, 50_000]]), // bob sub-dust, charlie included
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.consideredAddresses.has(ALICE)).toBe(true);
        expect(r.consideredAddresses.has(BOB)).toBe(true);    // sub-dust pending also counts
        expect(r.consideredAddresses.has(CHARLIE)).toBe(true);
    });

    it('totalPendingSettled reports the sum that was absorbed into the distribution', () => {
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            pendingBalances: new Map([[ALICE, 500], [BOB, 1000], [CHARLIE, 2000]]),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.totalPendingSettled).toBe(3500);
    });

    // ── Pathological-case guard ────────────────────────────────

    it('totalPending > rewardForMiners → safe fallback to fee-100%, no bad-cb-amount risk', () => {
        // Pathological case: accumulated pending exceeds what this block
        // can cover. Pre-fix the code returned a distribution whose total
        // exceeded blockReward (sum of miner totalSats > rewardForMiners
        // plus the fee output), which would get rejected by Core with
        // bad-cb-amount. Post-fix: we fall back to a safe fee-100% payout
        // and preserve pending for future blocks.
        const reward = 1_000_000; // tiny reward so pending can swamp it
        const feePercent = 2;
        const rewardForMiners = Math.floor(0.98 * reward); // 980 000
        const bigPending = rewardForMiners + 100; // just over
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100 }),
                pendingBalances: new Map([[BOB, bigPending]]),
                blockRewardSats: reward,
                feePercent,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });
            // Fallback: fee gets 100%.
            expect(r.payouts).toEqual([{ address: FEE_ADDR, percent: 100 }]);
            expect(r.totalPendingSettled).toBe(0);
            // And the coinbase total does NOT exceed the block reward.
            expect(sumSatsFromPayouts(r.payouts, reward)).toBeLessThanOrEqual(reward);
            // And the critical log fired — operator needs a loud signal.
            expect(errorSpy).toHaveBeenCalled();
            expect(errorSpy.mock.calls[0][0]).toMatch(/CRITICAL/);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('totalPending > rewardForMiners with no fee address → empty payouts', () => {
        const reward = 1_000_000;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100 }),
                pendingBalances: new Map([[BOB, 2_000_000]]),
                blockRewardSats: reward,
                feePercent: 0,
                feeAddress: '',
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });
            expect(r.payouts).toEqual([]);
            expect(r.totalPendingSettled).toBe(0);
        } finally {
            errorSpy.mockRestore();
        }
    });

    // ── Sum invariants under varied loads ──────────────────────

    it('sum of percents always ≤ 100 within tolerance', () => {
        // Randomized property-style check.
        const reward = 5_000_000_000;
        for (let trial = 0; trial < 20; trial++) {
            const sharesIn: Record<string, number> = {};
            const pending = new Map<string, number>();
            const n = 2 + Math.floor(Math.random() * 15);
            for (let i = 0; i < n; i++) {
                sharesIn[`bc1qaddr${i}`] = Math.floor(Math.random() * 10000) + 1;
                if (Math.random() < 0.6) {
                    pending.set(`bc1qaddr${i}`, Math.floor(Math.random() * 5000));
                }
            }
            const r = buildCoinbaseDistribution({
                addressShares: shares(sharesIn),
                pendingBalances: pending,
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });
            const totalPct = r.payouts.reduce((s, p) => s + p.percent, 0);
            expect(totalPct).toBeLessThanOrEqual(100.001);
            const totalSats = sumSatsFromPayouts(r.payouts, reward);
            expect(totalSats).toBeLessThanOrEqual(reward);
        }
    });
});
