import {
    buildCoinbaseDistribution,
    CoinbaseDistributionEntry,
    DUST_LIMIT_SATS,
    DEFAULT_MIN_PAYOUT_SATS,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
    COINBASE_BASE_WEIGHT,
    COINBASE_OUTPUT_WEIGHT,
    COINBASE_WITNESS_COMMITMENT_WEIGHT,
    resolveMinPayoutSats,
} from './coinbase-distribution';

const FEE_ADDR = 'bc1qfee';
const ALICE = 'bc1qalice';
const BOB = 'bc1qbob';
const CHARLIE = 'bc1qcharlie';
const DAVE = 'bc1qdave';
const EVE = 'bc1qeve';

function shares(obj: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(obj));
}

function balances(obj: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(obj));
}

function sumOnChainSats(payouts: CoinbaseDistributionEntry[]): number {
    return payouts.reduce((s, p) => s + p.sats, 0);
}

function sumBalanceAfter(balanceAfter: Map<string, number>): number {
    let s = 0;
    for (const v of balanceAfter.values()) s += v;
    return s;
}

describe('buildCoinbaseDistribution — credit/debit ledger model', () => {

    // ── Basic ─────────────────────────────────────────────────

    it('no shares + no fee → empty payouts', () => {
        const r = buildCoinbaseDistribution({
            addressShares: new Map(),
            balances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: '',
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toEqual([]);
        expect(r.balanceAfter.size).toBe(0);
    });

    it('no shares + fee configured → 100 % to fee, ledger untouched', () => {
        const r = buildCoinbaseDistribution({
            addressShares: new Map(),
            balances: new Map([[ALICE, 1000]]),   // pre-existing credit
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toEqual([{
            address: FEE_ADDR,
            percent: 100,
            sats: 5_000_000_000,
        }]);
        // No work this block — balance stays as-is.
        expect(r.balanceAfter.size).toBe(0);
    });

    it('regression K3: feePercent set but feeAddress unset → full reward to miners (no burn)', () => {
        // K3 (audit): feeSats was unconditionally subtracted from
        // miner reward, but the fee output was only emitted if a
        // feeAddress was configured. With no feeAddress, the
        // configured fee% would be silently dropped — the coinbase
        // under-claimed by feeSats and those sats were forfeited.
        // Fix: when feeAddress is empty, feeSats must be 0 and miners
        // get the full subsidy.
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: '',
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const totalOnChain = r.payouts.reduce((s, p) => s + p.sats, 0);
        expect(totalOnChain).toBe(reward);
        expect(r.payouts.find(p => p.address === '')).toBeUndefined();
    });

    it('regression K3: feeAddress set but fee below dust → fee suppressed, miners get full reward', () => {
        // Same forfeit-class bug as above but triggered by tiny fee%
        // on a small reward (regtest, late-halving mainnet). The
        // existing test "tiny fee percent → fee output is dust → fee
        // omitted" was the canary that pre-fix asserted the WRONG
        // behaviour: miners still saw the deduction. After the fix,
        // when the fee is below minPayout the deduction is undone.
        const reward = 100_000;        // tiny block reward
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 0.01,          // → 10 sats, well below dust
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts.find(p => p.address === FEE_ADDR)).toBeUndefined();
        const totalOnChain = r.payouts.reduce((s, p) => s + p.sats, 0);
        // All sats either paid on-chain or kept in balanceAfter — none lost.
        const totalPending = Array.from(r.balanceAfter.values()).reduce((s, b) => s + b, 0);
        expect(totalOnChain + totalPending).toBe(reward);
    });

    it('two miners equal shares, no balance, 2 % fee → ~49/49/2', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts).toHaveLength(3);
        const fee = r.payouts.find(p => p.address === FEE_ADDR)!;
        const a = r.payouts.find(p => p.address === ALICE)!;
        const b = r.payouts.find(p => p.address === BOB)!;
        expect(fee.sats).toBe(Math.floor(reward * 0.02));
        expect(a.sats).toBeCloseTo(b.sats, -2);  // within ~100 sats of each other
        expect(a.percent).toBeCloseTo(49, 1);
        expect(b.percent).toBeCloseTo(49, 1);
    });

    // ── Pool-neutrality invariant (up to floor drift) ─────────

    it('balanceAfter drift bounded by floor(reward/N) rounding across a block', () => {
        // With strictly flooring rawFair the total rawFair is < reward by
        // up to (N-1) sats. The algorithm distributes that residuum as
        // on-chain bonus which creates a tiny matching debit. Across
        // a single block the ledger drift is therefore bounded by the
        // miner count.
        const reward = 5_000_000_000;
        const nMiners = 3;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100, [CHARLIE]: 100 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const drift = sumBalanceAfter(r.balanceAfter);
        // Drift is non-positive (flooring never creates credits from thin air)
        // and bounded below by -nMiners (each miner loses at most 1 sat of
        // rawFair to the floor).
        expect(drift).toBeLessThanOrEqual(0);
        expect(drift).toBeGreaterThanOrEqual(-nMiners);
    });

    it('sum of miner on-chain outputs = rewardForMiners (full coinbase covered)', () => {
        // Pool-neutral input (no pre-existing drift): sum balance_old = 0.
        const reward = 5_000_000_000;
        const feePercent = 2;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 150, [BOB]: 100, [CHARLIE]: 50 }),
            balances: new Map([[ALICE, -300], [BOB, 300]]),  // sums to 0
            blockRewardSats: reward,
            feePercent,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const feeSats = Math.floor(feePercent / 100 * reward);
        const rewardForMiners = reward - feeSats;
        const onChainMiners = r.payouts
            .filter(p => p.address !== FEE_ADDR)
            .reduce((s, p) => s + p.sats, 0);
        // On-chain miner total exactly equals rewardForMiners (no sats
        // silently burnt; the algorithm distributes every available sat).
        expect(onChainMiners).toBe(rewardForMiners);
    });

    // ── Pending credit claimed out ─────────────────────────────

    it('pending-only miner with ≥ dust balance gets paid on-chain when matching debit is active', () => {
        // Pool-neutral: Charlie has +50 000 credit, Alice has -50 000 debit
        // (e.g. Alice got a residuum bonus last block, Charlie is the
        // sub-dust accumulator). Alice is active, so her debit is offset
        // via reduced rawFair, freeing the 50 000 sats to pay Charlie.
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            balances: new Map([[CHARLIE, 50_000], [ALICE, -50_000]]),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const charlie = r.payouts.find(p => p.address === CHARLIE);
        expect(charlie).toBeDefined();
        expect(charlie!.sats).toBe(50_000);
        expect(r.balanceAfter.get(CHARLIE)).toBe(0);  // credit cleared
        expect(r.balanceAfter.get(ALICE)).toBe(0);    // debit cleared via reduced rawFair
    });

    it('pending-only miner < dust stays off-chain, balance unchanged', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            balances: new Map([[CHARLIE, 100]]),  // < 546
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts.find(p => p.address === CHARLIE)).toBeUndefined();
        expect(r.balanceAfter.get(CHARLIE)).toBe(100);  // credit carried forward
    });

    it('active miner with positive balance: target = rawFair + credit, paid on-chain', () => {
        // Pool-neutral: Alice +10 000 offset by Bob -10 000. Both active →
        // Alice's credit paid out via Bob's rawFair reduction.
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            balances: new Map([[ALICE, 10_000], [BOB, -10_000]]),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const a = r.payouts.find(p => p.address === ALICE)!;
        const b = r.payouts.find(p => p.address === BOB)!;
        // Alice on-chain > Bob by 20 000 (10k credit + 10k debt offset).
        expect(a.sats - b.sats).toBeGreaterThanOrEqual(20_000 - 10);
        expect(r.balanceAfter.get(ALICE)).toBe(0);   // credit cleared
        expect(r.balanceAfter.get(BOB)).toBe(0);     // debt cleared
    });

    it('active miner with negative balance: target = rawFair - debt, pays back on-chain', () => {
        // Pool-neutral: Alice -10 000 offset by Charlie +10 000 (pending-only).
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
            balances: new Map([[ALICE, -10_000], [CHARLIE, 10_000]]),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const a = r.payouts.find(p => p.address === ALICE)!;
        const b = r.payouts.find(p => p.address === BOB)!;
        // Alice on-chain < Bob by ~10 000 (rawFair - debt).
        expect(b.sats - a.sats).toBeGreaterThanOrEqual(10_000 - 10);
        expect(r.balanceAfter.get(ALICE)).toBe(0);   // debt cleared
        // Charlie (pending-only credit) was paid out, credit cleared.
        expect(r.balanceAfter.get(CHARLIE)).toBe(0);
    });

    // ── Phase 5a: trim bonus redistribution ────────────────────

    it('trim bonus distributed proportional to shares among kept active miners', () => {
        // 50 eligible outputs, tight budget to force trim; verify the
        // trimmed miners' target is redistributed proportionally.
        const addressShares = new Map<string, number>();
        for (let i = 0; i < 50; i++) {
            // Alice and Bob dominate; others are tiny
            if (i === 0) addressShares.set(ALICE, 1_000_000);
            else if (i === 1) addressShares.set(BOB, 500_000);
            else addressShares.set(`bc1qtiny${i}`, 10_000);
        }
        const r = buildCoinbaseDistribution({
            addressShares,
            balances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: 1500,  // tight budget → trim
        });

        const a = r.payouts.find(p => p.address === ALICE)!;
        const b = r.payouts.find(p => p.address === BOB)!;
        expect(a).toBeDefined();
        expect(b).toBeDefined();

        // Alice's share ratio = 1M / (1M + 500K + 48*10K) = 1M / 1.98M ≈ 0.505
        // Bob's ratio ≈ 0.253. So Alice's bonus should be ~2× Bob's.
        const aliceBalance = r.balanceAfter.get(ALICE) ?? 0;
        const bobBalance = r.balanceAfter.get(BOB) ?? 0;
        expect(aliceBalance).toBeLessThan(0);   // got bonus → debit
        expect(bobBalance).toBeLessThan(0);
        expect(Math.abs(aliceBalance)).toBeGreaterThan(Math.abs(bobBalance));
    });

    it('trimmed miner target stays as their new balance (carry-forward credit)', () => {
        const addressShares = new Map<string, number>();
        for (let i = 0; i < 10; i++) {
            addressShares.set(`bc1qaddr${i}`, 100_000 - i * 5000);
        }
        const r = buildCoinbaseDistribution({
            addressShares,
            balances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: 1200,  // fits ~3 miner outputs
        });
        const keptAddrs = new Set(r.payouts
            .filter(p => p.address !== FEE_ADDR)
            .map(p => p.address));
        // Miners not in kept but eligible (trimmed) should have their
        // target in balanceAfter as positive credit carry-forward.
        const trimmedAddrs = [...addressShares.keys()].filter(a => !keptAddrs.has(a));
        let trimmedWithPositiveCredit = 0;
        for (const addr of trimmedAddrs) {
            const bal = r.balanceAfter.get(addr) ?? 0;
            if (bal > 0) trimmedWithPositiveCredit++;
        }
        expect(trimmedWithPositiveCredit).toBeGreaterThan(0);
    });

    // ── Regression: pending-only trimmed credit-holders must not overshoot ─

    it('regression C1: many pending-only credit-holders trimmed → no fee-100% fallback, no overshoot', () => {
        // Scenario (pool-aged, real reachable state): 300 abandoned-but-
        // not-yet-swept pending-only credit-holders at +600 sats each +
        // 1 active miner "Alice" with all the shares. Default weight
        // budget fits ~286 outputs, so 15 credit-holders get trimmed.
        //
        // Pre-fix bug: trimmedTotal = 15 × 600 = 9_000 gets redistributed
        // to Alice as on-chain bonus + matching debit. Alice's on-chain =
        // rawFair + 9_000 = rewardForMiners + 9_000. Phase 5a.5 sees
        // overshoot = 9_000 + 285×600 = 180_000 but totalCredit-in-kept
        // is only 285×600 = 171_000. overshoot > totalCredit → falls
        // through to CRITICAL fee-100% fallback → miners lose full block.
        //
        // Post-fix: trimmedTotal only counts active trimmed (none here),
        // so no Phase 5a bonus. Phase 5a.5 cuts the kept credit-holders
        // proportionally; trimmed credit-holders carry their 600 forward
        // unchanged. No overshoot, no fallback.
        const reward = 5_000_000_000;
        const feePercent = 2;
        const feeSats = Math.floor(reward * feePercent / 100);
        const rewardForMiners = reward - feeSats;

        const balancesIn = new Map<string, number>();
        for (let i = 0; i < 300; i++) balancesIn.set(`bc1qpend${i}`, 600);

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100 }),
                balances: balancesIn,
                blockRewardSats: reward,
                feePercent,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });

            // Fee-100% fallback did NOT fire — there are ≥ 2 on-chain outputs
            // (fee + Alice + some of the kept creditors).
            expect(r.payouts.length).toBeGreaterThan(1);
            const fee = r.payouts.find(p => p.address === FEE_ADDR)!;
            expect(fee.percent).toBe(feePercent);
            expect(fee.sats).toBe(feeSats);

            // Alice got her full rawFair (~rewardForMiners minus the tiny
            // portion used to pay kept credit-holders on-chain).
            const alice = r.payouts.find(p => p.address === ALICE)!;
            expect(alice).toBeDefined();
            expect(alice.sats).toBeGreaterThan(rewardForMiners - 200_000);

            // On-chain never exceeds the block reward.
            expect(sumOnChainSats(r.payouts)).toBeLessThanOrEqual(reward);
            const minersOnChain = r.payouts
                .filter(p => p.address !== FEE_ADDR)
                .reduce((s, p) => s + p.sats, 0);
            expect(minersOnChain).toBeLessThanOrEqual(rewardForMiners);

            // No CRITICAL fee-100% log emitted.
            const criticalLogs = errorSpy.mock.calls
                .flat()
                .filter((msg: any) => typeof msg === 'string' && msg.includes('CRITICAL'));
            expect(criticalLogs).toHaveLength(0);

            // Trimmed pending-only credit-holders carried their 600 sat
            // balance forward unchanged (no phantom-sat redistribution).
            const trimmedCreditors = [...balancesIn.keys()].filter(addr => {
                const paid = r.payouts.find(p => p.address === addr);
                return !paid;
            });
            expect(trimmedCreditors.length).toBeGreaterThan(0);
            for (const addr of trimmedCreditors) {
                const carry = r.balanceAfter.get(addr);
                // Either unchanged at 600 (pure trimmed) or partially cut
                // back by the Phase 5a.5 solvency cap — but never negative,
                // never larger than the original claim.
                expect(carry).toBeGreaterThanOrEqual(0);
                expect(carry).toBeLessThanOrEqual(600);
            }

            // Sum conservation: sum(balanceAfter) ≈ sum(balanceBefore) ± N.
            let sumBefore = 0;
            for (const v of balancesIn.values()) sumBefore += v;
            const allAddrs = new Set<string>([ALICE, ...balancesIn.keys()]);
            let sumAfter = 0;
            for (const a of allAddrs) {
                sumAfter += r.balanceAfter.has(a)
                    ? r.balanceAfter.get(a)!
                    : (balancesIn.get(a) ?? 0);
            }
            const drift = sumAfter - sumBefore;
            expect(Math.abs(drift)).toBeLessThanOrEqual(allAddrs.size);
        } finally {
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    // ── Phase 5a.5: Solvency cap (EdgeCase A: abandoned-debtor overshoot) ──

    it('EdgeCase A: abandoned debtor + pending-only creditor → solvency cap delays credit claim', () => {
        // Block A-ish setup: D received 200 bonus in a prior block and
        // has since abandoned → D.balance = -200. X earned 800 pending
        // credit → X.balance = +800. Now A, B, C come in to mine.
        //
        // Without solvency cap: sum(kept.target) = 3×1,999,800 + 800 =
        //                       6,000,200 > rewardForMiners (6M) →
        //                       would trigger bad-cb-amount.
        // With solvency cap:    X's credit trimmed by 200, X gets 600
        //                       on-chain, balance_new = 200 carry-forward.
        //                       A, B, C still get full (rawFair - 200) =
        //                       1,999,800 each on-chain.
        const reward = 6_122_449;     // so rewardForMiners after 2% fee = 6_000_000
        // Actually simpler: pick reward cleanly.
        // feePercent=2, rewardForMiners = floor(0.98 * reward)
        // Want rewardForMiners = 6_000_000 → reward / 0.98 ≈ 6_122_449
        // But Math.floor: 6_122_449 × 0.02 = 122_448.98 → floor 122_448,
        // rewardForMiners = 6_122_449 - 122_448 = 6_000_001. Close enough.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100, [CHARLIE]: 100 }),
                balances: balances({
                    [ALICE]: -200, [BOB]: -200, [CHARLIE]: -200,
                    [DAVE]: -200,      // abandoned debtor
                    [EVE]: +800,       // pending-only credit-claimer
                }),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });

            // Fee fallback did NOT fire — we have multiple miners paid.
            expect(r.payouts.length).toBeGreaterThan(1);

            // Eve (credit-claimer) received on-chain, but cut from her
            // original 800 claim.
            const eve = r.payouts.find(p => p.address === EVE)!;
            expect(eve).toBeDefined();
            expect(eve.sats).toBeLessThan(800);

            // Eve's balance carries the shortfall forward as a positive credit.
            const eveBalance = r.balanceAfter.get(EVE) ?? 0;
            expect(eveBalance).toBeGreaterThan(0);
            expect(eve.sats + eveBalance).toBe(800);  // full claim preserved

            // Dave's debit is UNCHANGED (he abandoned, no offset this block).
            expect(r.balanceAfter.get(DAVE)).toBe(-200);

            // Active A, B, C: their debt cleared via reduced rawFair,
            // balance_new = 0 (or near 0 after Phase 5b proportional).
            // But because there's no residuum (sum on-chain = rewardForMiners
            // after solvency cap), balance_new should be exactly 0.
            expect(r.balanceAfter.get(ALICE)).toBe(0);
            expect(r.balanceAfter.get(BOB)).toBe(0);
            expect(r.balanceAfter.get(CHARLIE)).toBe(0);

            // Coinbase does NOT exceed the block reward.
            const totalOnChain = sumOnChainSats(r.payouts);
            expect(totalOnChain).toBeLessThanOrEqual(reward);

            // Solvency cap logged a warning.
            expect(warnSpy.mock.calls.some(c => c[0].match?.(/solvency cap/))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('multiple credit-claimers trimmed proportional to their balance_old', () => {
        // Two pending credit-claimers with different claims; one abandoned
        // debtor creates a shortfall. Verify the cut is proportional.
        const reward = 6_122_449;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                balances: balances({
                    [ALICE]: -200, [BOB]: -200,
                    [DAVE]: -1000,             // larger abandoned debit
                    [EVE]: +600,               // smaller credit-claimer
                    [CHARLIE]: +1800,          // larger credit-claimer
                }),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
            });

            // Shortfall = 1000 (Dave's unreturned debit).
            // Total credit = 600 + 1800 = 2400.
            // Eve cut ≈ 1000 × 600 / 2400 = 250.
            // Charlie cut ≈ 1000 × 1800 / 2400 = 750.
            const eve = r.payouts.find(p => p.address === EVE)!;
            const charlie = r.payouts.find(p => p.address === CHARLIE)!;
            expect(eve).toBeDefined();
            expect(charlie).toBeDefined();

            const eveCarry = r.balanceAfter.get(EVE) ?? 0;
            const charlieCarry = r.balanceAfter.get(CHARLIE) ?? 0;
            // Carry-forward roughly proportional to original balance.
            expect(charlieCarry).toBeGreaterThan(eveCarry);
            // Charlie carry / Eve carry ≈ 1800 / 600 = 3.
            expect(charlieCarry / eveCarry).toBeCloseTo(3, 0);

            // Sum(eve.sats + eveCarry) = 600 (original claim preserved).
            expect(eve.sats + eveCarry).toBe(600);
            expect(charlie.sats + charlieCarry).toBe(1800);
        } finally {
            warnSpy.mockRestore();
        }
    });

    // ── Phase 5b: proportional residuum (previously only-largest) ─

    it('residuum distributed proportionally to shares, matching debits created', () => {
        // Create true sub-dust: 30 tiny miners whose rawFair falls below
        // DUST_LIMIT_SATS. With reward 5B and share ratio 1 / (3*1e9 + 30),
        // each tiny miner gets floor(5B / 3e9) ≈ 1 sat rawFair.
        const reward = 5_000_000_000;
        const addressSharesMap = new Map<string, number>();
        addressSharesMap.set(ALICE, 1_000_000_000);
        addressSharesMap.set(BOB, 1_000_000_000);
        addressSharesMap.set(CHARLIE, 1_000_000_000);
        for (let i = 0; i < 30; i++) {
            addressSharesMap.set(`bc1qtiny${i}`, 1);
        }
        const r = buildCoinbaseDistribution({
            addressShares: addressSharesMap,
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });

        // Alice/Bob/Charlie each receive ~1/3 of the sub-dust residuum
        // as matching debit. Proportional → the three balances differ by
        // at most 1 sat (flooring residual).
        const aBal = r.balanceAfter.get(ALICE) ?? 0;
        const bBal = r.balanceAfter.get(BOB) ?? 0;
        const cBal = r.balanceAfter.get(CHARLIE) ?? 0;
        expect(Math.abs(aBal - bBal)).toBeLessThanOrEqual(1);
        expect(Math.abs(bBal - cBal)).toBeLessThanOrEqual(1);
        expect(aBal).toBeLessThan(0);

        // Sub-dust miners carry credit (balance > 0).
        let subDustCredits = 0;
        let subDustCount = 0;
        for (let i = 0; i < 30; i++) {
            const v = r.balanceAfter.get(`bc1qtiny${i}`) ?? 0;
            if (v > 0) {
                subDustCredits += v;
                subDustCount++;
            }
        }
        expect(subDustCount).toBeGreaterThan(0);

        // Pool-neutrality modulo floor: drift bounded by total miner count
        // (floor residuum is at most totalMiners - 1 sats per block).
        const totalMiners = addressSharesMap.size;
        const drift = sumBalanceAfter(r.balanceAfter);
        expect(Math.abs(drift)).toBeLessThanOrEqual(totalMiners);

        // Active miners' debits approximately match sub-dust credits
        // (debits equal credits + floor residuum absorption).
        const activeDebits = -(aBal + bBal + cBal);   // positive total debt
        expect(activeDebits).toBeGreaterThanOrEqual(subDustCredits);
        expect(activeDebits - subDustCredits).toBeLessThanOrEqual(totalMiners);
    });

    // ── C2: suppressMatchingDebits (group-solo mode) ──────────

    describe('suppressMatchingDebits (group-solo mode)', () => {

        it('regression C2: Phase 5b residuum goes to fee, not to active miners as debit', () => {
            // 3 miners with uneven shares to guarantee floor-rounding residuum.
            // In normal mode Alice (largest) would get the residuum + matching
            // debit. In suppress mode the residuum goes to the fee.
            const reward = 5_000_000_000;
            const feePercent = 2;
            const feeSats = Math.floor(reward * feePercent / 100);
            const rewardForMiners = reward - feeSats;

            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 111, [BOB]: 100, [CHARLIE]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                suppressMatchingDebits: true,
            });

            // Every miner's balanceAfter is 0 (or absent) — NO matching debits.
            for (const addr of [ALICE, BOB, CHARLIE]) {
                const bal = r.balanceAfter.get(addr) ?? 0;
                expect(bal).toBe(0);
            }

            // Fee output absorbed the residuum (floor-rounding tail).
            const fee = r.payouts.find(p => p.address === FEE_ADDR)!;
            expect(fee.sats).toBeGreaterThanOrEqual(feeSats);
            // Upper bound: can't be more than feeSats + N_miners sats of residuum.
            expect(fee.sats).toBeLessThanOrEqual(feeSats + 3);

            // Coinbase sum still = block reward.
            expect(sumOnChainSats(r.payouts)).toBe(reward);

            // Miners' on-chain totals = floor(share_i/total × rewardForMiners),
            // no bonus added.
            const total = 311;
            for (const [addr, shareCount] of [[ALICE, 111], [BOB, 100], [CHARLIE, 100]] as const) {
                const p = r.payouts.find(pp => pp.address === addr)!;
                expect(p.sats).toBe(Math.floor(shareCount / total * rewardForMiners));
            }
        });

        it('regression C2: trim redistribution goes to fee instead of creating debits', () => {
            // Tight budget → many miners trimmed. In normal mode the trim
            // total would be redistributed to the top 4 active miners with
            // matching debits. In suppress mode: fee absorbs it.
            const addressSharesMap = new Map<string, number>();
            for (let i = 0; i < 20; i++) addressSharesMap.set(`bc1qm${i}`, 100_000 - i * 1000);

            const reward = 5_000_000_000;
            const feeSats = Math.floor(reward * 0.02);

            const r = buildCoinbaseDistribution({
                addressShares: addressSharesMap,
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: 1500,   // fits ~4 miner outputs
                suppressMatchingDebits: true,
            });

            // No miner has a negative (debit) balance after — invariant for groups.
            for (const v of r.balanceAfter.values()) {
                expect(v).toBeGreaterThanOrEqual(0);
            }

            // Fee output is larger than the base feeSats (absorbed trim total).
            const fee = r.payouts.find(p => p.address === FEE_ADDR)!;
            expect(fee.sats).toBeGreaterThan(feeSats);

            // Coinbase sum still = block reward.
            expect(sumOnChainSats(r.payouts)).toBe(reward);

            // Trimmed miners' balanceAfter = their target (carry-forward as credit),
            // never negative.
            const keptAddrs = new Set(r.payouts.filter(p => p.address !== FEE_ADDR).map(p => p.address));
            const trimmedAddrs = [...addressSharesMap.keys()].filter(a => !keptAddrs.has(a));
            for (const addr of trimmedAddrs) {
                const bal = r.balanceAfter.get(addr) ?? 0;
                expect(bal).toBeGreaterThanOrEqual(0);
            }
        });

        it('suppressMatchingDebits without fee address → residuum unemitted (undershoot OK)', () => {
            // Edge: if the pool has no fee configured, residuum has nowhere
            // to go. Coinbase undershoots by that amount. Documented; not
            // a panic — the group accepts the tiny donation to subsidy.
            const reward = 5_000_000_000;
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 111, [BOB]: 100, [CHARLIE]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 0,
                feeAddress: '',
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                suppressMatchingDebits: true,
            });

            // No matching debits.
            for (const v of r.balanceAfter.values()) expect(v).toBeGreaterThanOrEqual(0);

            // Coinbase ≤ reward (may undershoot slightly due to residuum).
            expect(sumOnChainSats(r.payouts)).toBeLessThanOrEqual(reward);
            // Should be within N-miner sats of reward.
            expect(sumOnChainSats(r.payouts)).toBeGreaterThanOrEqual(reward - 3);
        });

        it('suppress mode preserves Phase 5a.5 solvency cap for positive pre-existing credits', () => {
            // A group member has an accumulated sub-dust credit from prior
            // blocks (pendingSats=+500). Next block, the targets overshoot
            // rewardForMiners. The cap must still trigger — suppression
            // is about MATCHING DEBITS, not about Phase 5a.5 itself.
            const reward = 1_000_000;   // small reward to force an overshoot
            const feePercent = 0;
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const r = buildCoinbaseDistribution({
                    addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                    balances: new Map([[ALICE, 800_000]]),   // huge pre-existing credit
                    blockRewardSats: reward,
                    feePercent,
                    feeAddress: FEE_ADDR,
                    coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                    suppressMatchingDebits: true,
                });

                // Alice's claim survives the cut — balanceAfter > 0.
                const aliceCarry = r.balanceAfter.get(ALICE) ?? 0;
                expect(aliceCarry).toBeGreaterThan(0);

                // Bob is untouched (active, no pre-existing balance, no debit either).
                expect(r.balanceAfter.get(BOB) ?? 0).toBe(0);

                // Coinbase ≤ reward.
                expect(sumOnChainSats(r.payouts)).toBeLessThanOrEqual(reward);
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    // ── Dust gates ────────────────────────────────────────────

    it('tiny fee percent → fee output is dust → fee omitted', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 0.00001,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        const addrs = r.payouts.map(p => p.address);
        expect(addrs).not.toContain(FEE_ADDR);
        expect(addrs).toEqual([ALICE]);
    });

    it('sub-dust miner (shares this round) is filtered out, balance credited', () => {
        const reward = 5_000_000_000;
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 1_000_000_000, [BOB]: 1 }),
            balances: new Map(),
            blockRewardSats: reward,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.payouts.find(p => p.address === BOB)).toBeUndefined();
        // Bob's tiny rawFair (~5 sats) stays as a positive credit in balance.
        const bobBalance = r.balanceAfter.get(BOB) ?? 0;
        expect(bobBalance).toBeGreaterThan(0);
        expect(bobBalance).toBeLessThan(DUST_LIMIT_SATS);
    });

    // ── Weight-budget trim ────────────────────────────────────

    it('trims smallest miners when budget cannot fit all outputs', () => {
        const addressShares = new Map<string, number>();
        for (let i = 0; i < 50; i++) {
            addressShares.set(`bc1qaddr${i}`, 100_000 - i * 1000);
        }
        const r = buildCoinbaseDistribution({
            addressShares,
            balances: new Map(),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: 1500,
        });
        const minerOutputs = r.payouts.filter(p => p.address !== FEE_ADDR);
        expect(minerOutputs.length).toBe(4);
        const kept = minerOutputs.map(p => p.address).sort();
        expect(kept).toEqual(['bc1qaddr0', 'bc1qaddr1', 'bc1qaddr2', 'bc1qaddr3']);
    });

    // ── consideredAddresses bookkeeping ──────────────────────

    it('consideredAddresses captures shares + balance addresses', () => {
        const r = buildCoinbaseDistribution({
            addressShares: shares({ [ALICE]: 100 }),
            balances: new Map([[BOB, 100], [CHARLIE, 50_000]]),
            blockRewardSats: 5_000_000_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
        });
        expect(r.consideredAddresses.has(ALICE)).toBe(true);
        expect(r.consideredAddresses.has(BOB)).toBe(true);
        expect(r.consideredAddresses.has(CHARLIE)).toBe(true);
    });

    // ── Output-count varint budget regression ─────────────────

    it('budget reservation accounts for 3-byte output-count varint at ≥ 253 outputs', () => {
        const budget = DEFAULT_COINBASE_WEIGHT_BUDGET;
        const miners: Record<string, number> = {};
        for (let i = 0; i < 300; i++) miners[`bc1qm${i}`] = 1;

        const r = buildCoinbaseDistribution({
            addressShares: shares(miners),
            balances: new Map(),
            blockRewardSats: 312_500_000,
            feePercent: 2,
            feeAddress: FEE_ADDR,
            coinbaseWeightBudget: budget,
        });

        const totalOutputs = r.payouts.length;
        const paidCoinbaseWeight =
            328 /* base, post-fix */ +
            188 /* witness commitment */ +
            totalOutputs * 172;

        expect(paidCoinbaseWeight).toBeLessThanOrEqual(budget);
        expect(totalOutputs).toBeGreaterThan(252);
    });

    // ── Property tests: invariants across random loads ────────

    it('property: sum(on-chain) ≤ rewardForMiners across many random configurations', () => {
        const reward = 5_000_000_000;
        const feePercent = 2;
        const feeSats = Math.floor(reward * feePercent / 100);
        const rewardForMiners = reward - feeSats;

        for (let trial = 0; trial < 50; trial++) {
            const sharesIn: Record<string, number> = {};
            const balancesIn = new Map<string, number>();
            const n = 2 + Math.floor(Math.random() * 15);
            for (let i = 0; i < n; i++) {
                sharesIn[`bc1qaddr${i}`] = Math.floor(Math.random() * 10000) + 1;
                if (Math.random() < 0.6) {
                    // Mix of credits and debits.
                    const signed = Math.floor((Math.random() - 0.3) * 5000);
                    balancesIn.set(`bc1qaddr${i}`, signed);
                }
            }
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                const r = buildCoinbaseDistribution({
                    addressShares: shares(sharesIn),
                    balances: balancesIn,
                    blockRewardSats: reward,
                    feePercent,
                    feeAddress: FEE_ADDR,
                    coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                });
                const totalSats = sumOnChainSats(r.payouts);
                expect(totalSats).toBeLessThanOrEqual(reward);

                // Miners-only portion within rewardForMiners budget.
                const minersOnChain = r.payouts
                    .filter(p => p.address !== FEE_ADDR)
                    .reduce((s, p) => s + p.sats, 0);
                expect(minersOnChain).toBeLessThanOrEqual(rewardForMiners);
            } finally {
                warnSpy.mockRestore();
                errorSpy.mockRestore();
            }
        }
    });

    /**
     * L5 regression (signed-ledger audit finding): Phase 5a has an
     * "no kept active miners" branch that fires when trimmed.shares>0
     * miners exist but every kept miner is pending-only (shares=0).
     * In that case the trim total can't be redistributed (nothing
     * active to receive the bonus) and Phase 5a just warns. No test
     * previously exercised that branch — the finding flagged it as
     * practically unreachable on a real pool but still worth a
     * regression so a future refactor doesn't silently break it.
     *
     * Construction: 2 massive pending-only credits (target 1e10 each)
     * + 1 active miner with a regular rawFair target that's smaller.
     * coinbase weight budget keeps only 2 outputs → both pending
     * credits kept, active trimmed. keptActive.length = 0, branch
     * enters the else.
     *
     * After Phase 5a.5 solvency cap, the two pending credits get
     * clipped proportionally to fit rewardForMiners. No fee-100 %
     * fallback. Coinbase sum <= blockReward. No NaN/Infinity.
     */
    it('regression L5: trimmed active + all kept pending-only → warn, no fee-100% fallback, coinbase sane', () => {
        const reward = 5_000_000_000;
        // 11 pending-only creditors (balance=1e9 each, target=1e9) so
        // they fill the kept set. 1 active miner with share=1 gets a
        // huge rawFair (full pool of shares) but target=rawFair stays
        // smaller than 1e9 pending-only targets when we crank balances
        // up. Use balance 1e10 to guarantee the sort order.
        const pendingBalances = new Map<string, number>();
        for (let i = 0; i < 11; i++) pendingBalances.set(`bc1qp${i}`, 10_000_000_000);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 1 }),   // lone active miner
                balances: pendingBalances,
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                // Keep exactly 11 outputs — forces alice (smallest target) to trim.
                coinbaseWeightBudget: 11 * 172 + 328 + 188 + 172,
            });

            // No fee-100 % fallback (coinbase has more than just the fee row).
            const feeOnly = r.payouts.length === 1
                && r.payouts[0].address === FEE_ADDR
                && r.payouts[0].percent === 100;
            expect(feeOnly).toBe(false);

            // Coinbase sum must not exceed block reward (undershoot is OK
            // when the warn-branch fires, as documented in the code).
            expect(sumOnChainSats(r.payouts)).toBeLessThanOrEqual(reward);

            // Warn emitted for "trimmed X sats but no active kept miners".
            const warnCalls = warnSpy.mock.calls
                .map(args => args.join(' '))
                .filter(s => s.includes('no active kept miners'));
            expect(warnCalls.length).toBeGreaterThan(0);

            // All balance values finite.
            for (const v of r.balanceAfter.values()) {
                expect(Number.isFinite(v)).toBe(true);
            }
        } finally {
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    /**
     * M2 regression (signed-ledger audit finding): single-block tests
     * above cover the math in isolation, but do not exercise the
     * credit/debit matching *across* blocks. A fee-100% fallback can
     * fire when the *accumulated* state from many blocks (abandoned
     * credit holders mixing with an active set that collectively
     * overshoots rewardForMiners) trips the solvency cap — a pattern
     * no single-block test can reach.
     *
     * This simulation runs 20 blocks with ~50 miners, random churn
     * (each miner flips active/inactive per block at ~30 % prob),
     * random share counts. Invariants checked every block:
     *
     *   1. NO fee-100 % fallback fires (coinbase has > 1 output OR
     *      coinbase is at least not the degenerate fee-only case).
     *   2. Sum(on-chain) == blockReward (physical conservation).
     *   3. Sum(balances) drift stays within (blocks × N_miners) —
     *      documented bound from floor rounding.
     *   4. Balance values stay finite / non-NaN.
     *
     * Seeded RNG so regression reproduces.
     */
    it('property: 20-block simulation with random churn, drift bounded, no fee-100% fallback', () => {
        // Mulberry32 seeded PRNG for reproducibility.
        let seed = 0xC0DEBABE >>> 0;
        const rnd = () => {
            seed = (seed + 0x6D2B79F5) >>> 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        const NUM_MINERS = 50;
        const NUM_BLOCKS = 20;
        const BLOCK_REWARD = 5_000_000_000;
        const FEE_PCT = 2;

        // Persistent ledger across blocks.
        const balances = new Map<string, number>();
        for (let i = 0; i < NUM_MINERS; i++) balances.set(`bc1qm${i}`, 0);

        // Silence the noisy solvency-cap + trim logs; keep error spy so
        // we catch any unexpected CRITICAL fallback.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            for (let block = 0; block < NUM_BLOCKS; block++) {
                // Build this block's share window with random churn.
                const addressShares = new Map<string, number>();
                for (let i = 0; i < NUM_MINERS; i++) {
                    if (rnd() < 0.7) {   // 70 % active this block
                        addressShares.set(`bc1qm${i}`, Math.floor(rnd() * 10_000) + 1);
                    }
                }

                // Snapshot balances for the drift check.
                const balancesBefore = new Map(balances);
                const sumBefore = Array.from(balancesBefore.values())
                    .reduce((s, v) => s + v, 0);

                const r = buildCoinbaseDistribution({
                    addressShares,
                    balances,
                    blockRewardSats: BLOCK_REWARD,
                    feePercent: FEE_PCT,
                    feeAddress: FEE_ADDR,
                    coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                });

                // Invariant 1: no fee-100 % fallback. A fee-only coinbase
                // at 100 % is the CRITICAL fallback we must never hit on
                // a realistic workload.
                const feeOnly = r.payouts.length === 1
                    && r.payouts[0].address === FEE_ADDR
                    && r.payouts[0].percent === 100;
                expect(feeOnly).toBe(false);

                // Invariant 2: coinbase sum == block reward exactly
                // (signed-ledger refactor's core promise).
                expect(sumOnChainSats(r.payouts)).toBe(BLOCK_REWARD);

                // Invariant 4 (values finite): catch NaN/Infinity early.
                for (const v of r.balanceAfter.values()) {
                    expect(Number.isFinite(v)).toBe(true);
                }

                // Apply balance updates for the next block.
                for (const [addr, newBal] of r.balanceAfter.entries()) {
                    balances.set(addr, newBal);
                }

                // Invariant 3: cumulative drift bounded. Each block can
                // introduce up to N_miners sats of floor-rounding drift;
                // after b blocks total drift ≤ b × N_miners.
                const sumAfter = Array.from(balances.values())
                    .reduce((s, v) => s + v, 0);
                const cumulativeDrift = Math.abs(sumAfter);
                expect(cumulativeDrift).toBeLessThanOrEqual((block + 1) * NUM_MINERS);

                // Track that we exercise the trim branch sometimes —
                // not a hard assertion, just a sanity check to confirm
                // the test setup produces a realistic mix. (Commented
                // out to avoid test flakes if churn picks an easy seed.)
                // if (r.payouts.length - 1 < addressShares.size) trimCount++;

                // Per-block sanity: ledger-delta matches onchain undershoot
                // relative to blockReward - feeSats.
                void sumBefore;   // (kept for debugging — not asserted)
            }
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it('property: ledger drift bounded by number of kept miners each block', () => {
        // Build pool-neutral ledgers of random shape, run the algorithm,
        // verify drift is bounded by N (number of kept miners) across
        // many random configurations.
        for (let trial = 0; trial < 30; trial++) {
            const sharesIn: Record<string, number> = {};
            const balancesIn = new Map<string, number>();
            const n = 3 + Math.floor(Math.random() * 10);
            let accumulator = 0;
            for (let i = 0; i < n; i++) {
                sharesIn[`bc1qaddr${i}`] = Math.floor(Math.random() * 10000) + 1;
                if (i < n - 1) {
                    const signed = Math.floor((Math.random() - 0.5) * 4000);
                    balancesIn.set(`bc1qaddr${i}`, signed);
                    accumulator += signed;
                } else {
                    // Last miner balances the ledger to sum = 0.
                    balancesIn.set(`bc1qaddr${i}`, -accumulator);
                }
            }

            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const r = buildCoinbaseDistribution({
                    addressShares: shares(sharesIn),
                    balances: balancesIn,
                    blockRewardSats: 5_000_000_000,
                    feePercent: 2,
                    feeAddress: FEE_ADDR,
                    coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                });

                const feeOnly = r.payouts.length === 1 && r.payouts[0].address === FEE_ADDR
                    && r.payouts[0].percent === 100;
                if (feeOnly) continue;

                // Compare sum(balance_old) (over all addresses seen) to
                // sum(balance_new). Drift comes from floor rounding in
                // rawFair; bounded by the kept-active count.
                const allAddrs = new Set<string>([
                    ...Object.keys(sharesIn),
                    ...balancesIn.keys(),
                ]);
                let sumOld = 0;
                let sumNew = 0;
                for (const a of allAddrs) {
                    sumOld += balancesIn.get(a) ?? 0;
                    sumNew += r.balanceAfter.has(a)
                        ? r.balanceAfter.get(a)!
                        : (balancesIn.get(a) ?? 0);
                }
                expect(sumOld).toBe(0);
                const drift = sumNew - sumOld;
                expect(Math.abs(drift)).toBeLessThanOrEqual(n);
            } finally {
                warnSpy.mockRestore();
            }
        }
    });

    // ── Group-Solo finder bonus ────────────────────────────────────

    describe('finder bonus (Group-Solo)', () => {

        it('emits a separate bonus output to the finder, on top of their proportional share', () => {
            const reward = 5_000_000_000;
            const bonus = 50_000_000;  // 0.5 BTC bonus
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                finderBonusSats: bonus,
                finderAddress: ALICE,
            });
            // Three outputs: fee + bonus + 2 miners
            // (or fee + bonus + Alice + Bob, with Alice's main output being half of (reward - fee - bonus))
            expect(r.payouts.length).toBe(4);
            const fee = r.payouts.find(p => p.address === FEE_ADDR)!;
            const bonusOut = r.payouts.filter(p => p.address === ALICE).find(p => p.sats === bonus);
            const aliceProp = r.payouts.filter(p => p.address === ALICE).find(p => p.sats !== bonus);
            const bobOut = r.payouts.find(p => p.address === BOB)!;

            expect(fee.sats).toBe(Math.floor(reward * 0.02));
            expect(bonusOut).toBeDefined();
            expect(bonusOut!.sats).toBe(bonus);
            // Alice's proportional share = (reward - fee - bonus) / 2 (equal shares)
            const minerCutAfterBonus = reward - fee.sats - bonus;
            expect(aliceProp!.sats).toBeCloseTo(minerCutAfterBonus / 2, -2);
            expect(bobOut.sats).toBeCloseTo(minerCutAfterBonus / 2, -2);

            // Total on-chain = block reward (no leak)
            expect(sumOnChainSats(r.payouts)).toBe(reward);
        });

        it('bonus capped at 95 % of miner-cut when configured value would exceed', () => {
            const reward = 100_000_000;        // 1 BTC
            const fee = Math.floor(reward * 0.02);  // 2 % = 2_000_000
            const minerCut = reward - fee;           // 98_000_000
            const cap = Math.floor(minerCut * 0.95); // 93_100_000
            const bigBonus = minerCut;                // configured = full miner-cut → must be capped
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                finderBonusSats: bigBonus,
                finderAddress: ALICE,
            });
            const bonusOut = r.payouts.filter(p => p.address === ALICE).find(p => p.sats === cap);
            expect(bonusOut).toBeDefined();
            expect(bonusOut!.sats).toBe(cap);
            expect(sumOnChainSats(r.payouts)).toBe(reward);
        });

        it('bonus suppressed when the resulting amount would be below minPayout (sub-dust gate)', () => {
            // Tiny configured bonus relative to a tiny block reward —
            // bonus output would be sub-dust, so the feature is silently
            // skipped and the full miner-cut goes to the proportional split.
            const reward = 100_000;
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 0,
                feeAddress: '',
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                finderBonusSats: 100,           // way below dust
                finderAddress: ALICE,
                minPayoutSats: 5000,
            });
            // Only 2 miner outputs — no bonus output emitted
            expect(r.payouts).toHaveLength(2);
            expect(sumOnChainSats(r.payouts)).toBe(reward);
        });

        it('no bonus when finderBonusSats is 0 / undefined / negative', () => {
            const reward = 5_000_000_000;
            for (const v of [undefined, 0, -1]) {
                const r = buildCoinbaseDistribution({
                    addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                    balances: new Map(),
                    blockRewardSats: reward,
                    feePercent: 2,
                    feeAddress: FEE_ADDR,
                    coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                    finderBonusSats: v as any,
                    finderAddress: ALICE,
                });
                // No second Alice output
                expect(r.payouts.filter(p => p.address === ALICE)).toHaveLength(1);
                expect(sumOnChainSats(r.payouts)).toBe(reward);
            }
        });

        it('no bonus when finderAddress is unset, even if finderBonusSats > 0', () => {
            const reward = 5_000_000_000;
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                finderBonusSats: 50_000_000,
                finderAddress: undefined,
            });
            // Standard 3-output coinbase: fee + 2 miners
            expect(r.payouts).toHaveLength(3);
            expect(sumOnChainSats(r.payouts)).toBe(reward);
        });

        it('finder is the only miner — bonus + 100 % of remaining miner-cut go to them', () => {
            const reward = 5_000_000_000;
            const bonus = 100_000_000;
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: DEFAULT_COINBASE_WEIGHT_BUDGET,
                finderBonusSats: bonus,
                finderAddress: ALICE,
            });
            // Fee + bonus + 1 miner output = 3 outputs (Alice has 2: bonus + main)
            expect(r.payouts).toHaveLength(3);
            const aliceTotal = r.payouts
                .filter(p => p.address === ALICE)
                .reduce((s, p) => s + p.sats, 0);
            const expectedFee = Math.floor(reward * 0.02);
            expect(aliceTotal).toBe(reward - expectedFee);
            expect(sumOnChainSats(r.payouts)).toBe(reward);
        });

        it('weight-budget reservation: bonus output counts towards the trim ceiling', () => {
            // Tight budget: enough for fee + bonus + 1 miner output. With
            // 3 miners, 2 must trim. Without bonus accounting, we'd
            // wrongly fit 2 miners and overshoot the budget.
            const reward = 5_000_000_000;
            const bonus = 50_000_000;
            // Budget = base (328) + witness (188) + 3 outputs (3 × 172 = 516) = 1032
            // → fits fee, bonus, and 1 miner output. With 3 miners → trim 2.
            const tightBudget = 1032;
            const r = buildCoinbaseDistribution({
                addressShares: shares({ [ALICE]: 100, [BOB]: 80, [CHARLIE]: 60 }),
                balances: new Map(),
                blockRewardSats: reward,
                feePercent: 2,
                feeAddress: FEE_ADDR,
                coinbaseWeightBudget: tightBudget,
                finderBonusSats: bonus,
                finderAddress: ALICE,
            });
            // Alice's bonus + Alice's prop output (kept) + fee = 3 outputs
            expect(r.payouts).toHaveLength(3);
            // Bob and Charlie were trimmed → carried as pending balance
            expect(r.balanceAfter.has(BOB)).toBe(true);
            expect(r.balanceAfter.has(CHARLIE)).toBe(true);
        });
    });

    /**
     * Consensus-validity invariant — the only things that matter for
     * Bitcoin Core to accept the block we build:
     *
     *   1. sum(coinbase output sats) ≤ blockReward    (bad-cb-amount)
     *   2. coinbase weight ≤ configured budget         (oversized coinbase
     *                                                   pushes the block past
     *                                                   weight limits)
     *
     * Existing tests assert specific math (alice gets X, bob gets Y).
     * This block fuzzes the entire input space the engine actually
     * sees in production — every payout mode flag, every reward level
     * across halvings, group sizes from 1 to 30, with/without bonus,
     * with/without fee — and asserts only the two invariants. Catches
     * the case the test author didn't think to test for. If a future
     * refactor introduces a path where Core would reject our block,
     * this fuzzer will catch it before regtest does.
     *
     * 500 trials × every code path = ~5k branch executions per run.
     * Pure-function, ~50 ms total.
     */
    describe('consensus-validity invariants (fuzz)', () => {
        const REWARDS = [
            5_000_000_000,        // pre-2024 subsidy
            3_125_000_000,        // post-2024 subsidy
            1_562_500_000,        // post-2028 subsidy
            390_625_000,          // post-2036 subsidy
            48_828_125,           // late-era subsidy + small fees
            1_000_000_000,        // round number, lots of fees
        ];

        function rand<T>(arr: T[]): T {
            return arr[Math.floor(Math.random() * arr.length)];
        }

        function maxOutputsForBudget(budget: number, hasFee: boolean, hasBonus: boolean): number {
            const fixed = COINBASE_BASE_WEIGHT + COINBASE_WITNESS_COMMITMENT_WEIGHT;
            const overheadOutputs = (hasFee ? 1 : 0) + (hasBonus ? 1 : 0);
            const remaining = budget - fixed - overheadOutputs * COINBASE_OUTPUT_WEIGHT;
            return Math.max(0, Math.floor(remaining / COINBASE_OUTPUT_WEIGHT));
        }

        it('500 random configurations — sum(payouts.sats) ≤ blockReward AND weight ≤ budget', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                for (let trial = 0; trial < 500; trial++) {
                    // Randomize the entire input surface.
                    const reward = rand(REWARDS);
                    const feePercent = rand([0, 0.5, 1, 2, 2.5, 5]);
                    const feeAddress = Math.random() < 0.85 ? FEE_ADDR : '';
                    const suppressMatchingDebits = Math.random() < 0.5;
                    const minPayoutSats = rand([DUST_LIMIT_SATS, 1000, 5000, 10000]);
                    const budget = rand([
                        DEFAULT_COINBASE_WEIGHT_BUDGET,
                        20_000,    // tight — forces trim
                        5_000,     // very tight — forces aggressive trim
                        100_000,   // generous
                    ]);

                    const n = 1 + Math.floor(Math.random() * 30);
                    const sharesIn: Record<string, number> = {};
                    const balancesIn = new Map<string, number>();
                    for (let i = 0; i < n; i++) {
                        const addr = `bc1qaddr${i}`;
                        if (Math.random() < 0.85) {
                            sharesIn[addr] = Math.floor(Math.random() * 10000) + 1;
                        }
                        if (Math.random() < 0.5) {
                            // Balanced mix of credits and debits, ledger-style.
                            const sign = Math.random() < 0.5 ? 1 : -1;
                            const mag = Math.floor(Math.random() * 20000);
                            balancesIn.set(addr, sign * mag);
                        }
                    }

                    // Optionally enable finder bonus on a random member.
                    const wantBonus = Math.random() < 0.4;
                    let finderBonusSats: number | undefined;
                    let finderAddress: string | undefined;
                    if (wantBonus) {
                        const candidates = Object.keys(sharesIn);
                        if (candidates.length > 0) {
                            finderAddress = rand(candidates);
                            // Mix of well-above-min, just-above-min, and
                            // unrealistically-large bonuses (test the 95 % cap).
                            finderBonusSats = rand([
                                10_000, 100_000, 1_000_000,
                                Math.floor(reward * 0.5),
                                Math.floor(reward * 2),     // exceeds reward → cap kicks in
                            ]);
                        }
                    }

                    const r = buildCoinbaseDistribution({
                        addressShares: shares(sharesIn),
                        balances: balancesIn,
                        blockRewardSats: reward,
                        feePercent,
                        feeAddress,
                        coinbaseWeightBudget: budget,
                        suppressMatchingDebits,
                        minPayoutSats,
                        finderBonusSats,
                        finderAddress,
                    });

                    // Invariant 1: bad-cb-amount safety.
                    // Sum of every coinbase output must not exceed the block reward.
                    // Core enforces this at consensus level — exceeding rejects
                    // the block. Equal is fine; under is fine (sats burn).
                    const totalEmitted = sumOnChainSats(r.payouts);
                    if (totalEmitted > reward) {
                        throw new Error(
                            `INVARIANT BROKEN (bad-cb-amount): trial=${trial} totalEmitted=${totalEmitted} > reward=${reward}\n`
                            + `  config: feePct=${feePercent} feeAddr='${feeAddress}' suppressDebits=${suppressMatchingDebits} `
                            + `minPayout=${minPayoutSats} budget=${budget} bonus=${finderBonusSats} bonusAddr=${finderAddress}\n`
                            + `  shares: ${JSON.stringify(sharesIn)}\n`
                            + `  balances: ${JSON.stringify(Object.fromEntries(balancesIn))}\n`
                            + `  payouts: ${JSON.stringify(r.payouts)}`,
                        );
                    }

                    // Invariant 2: weight-budget safety.
                    // Coinbase output count, when serialized, must not push
                    // the coinbase past the configured weight budget. The
                    // engine's trim phase enforces this; this asserts the
                    // enforcement actually held.
                    const hasFeeOut = r.payouts.some(p => p.address === feeAddress) && !!feeAddress;
                    const hasBonusOut = !!finderAddress
                        && r.payouts.some(p => p.address === finderAddress && p.sats === Math.min(
                            finderBonusSats ?? 0,
                            Math.floor((reward - Math.floor(reward * feePercent / 100)) * 0.95),
                        ));
                    const actualWeight = COINBASE_BASE_WEIGHT
                        + COINBASE_WITNESS_COMMITMENT_WEIGHT
                        + r.payouts.length * COINBASE_OUTPUT_WEIGHT;
                    if (actualWeight > budget && r.payouts.length > 0) {
                        throw new Error(
                            `INVARIANT BROKEN (weight overrun): trial=${trial} weight=${actualWeight} > budget=${budget} `
                            + `(${r.payouts.length} outputs, hasFee=${hasFeeOut}, hasBonus=${hasBonusOut})\n`
                            + `  shares: ${JSON.stringify(sharesIn)}`,
                        );
                    }

                    // Invariant 3: every emitted output is positive sats.
                    // Zero-sats outputs would still validate at the script
                    // level but are pointless and suggest a math bug. Pool
                    // engine should never emit them.
                    for (const p of r.payouts) {
                        if (p.sats <= 0) {
                            throw new Error(
                                `INVARIANT BROKEN (non-positive payout): trial=${trial} ${p.address} sats=${p.sats}`,
                            );
                        }
                    }
                }
            } finally {
                warnSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });
    });
});

describe('resolveMinPayoutSats', () => {
    it('returns the default when input is undefined', () => {
        expect(resolveMinPayoutSats(undefined)).toBe(DEFAULT_MIN_PAYOUT_SATS);
    });

    it('returns the parsed value when input is a positive integer string above the dust floor', () => {
        expect(resolveMinPayoutSats('10000')).toBe(10000);
    });

    it('clamps to DUST_LIMIT_SATS when input is below the floor', () => {
        expect(resolveMinPayoutSats('100')).toBe(DUST_LIMIT_SATS);
    });

    it('falls back to default + clamps when input is non-numeric', () => {
        expect(resolveMinPayoutSats('abc')).toBe(DEFAULT_MIN_PAYOUT_SATS);
    });

    it('falls back to default + clamps when input is zero', () => {
        expect(resolveMinPayoutSats('0')).toBe(DEFAULT_MIN_PAYOUT_SATS);
    });

    it('falls back to default + clamps when input is negative', () => {
        expect(resolveMinPayoutSats('-100')).toBe(DEFAULT_MIN_PAYOUT_SATS);
    });
});
