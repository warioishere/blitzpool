import {
    buildCoinbaseDistribution,
    CoinbaseDistributionEntry,
    DUST_LIMIT_SATS,
    DEFAULT_COINBASE_WEIGHT_BUDGET,
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
});
