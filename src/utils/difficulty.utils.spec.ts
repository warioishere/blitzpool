import { DifficultyUtils } from './difficulty.utils';

/**
 * Port-floor invariants for SV2 on payout-mode ports (PPLNS in
 * particular). The sequence `clampDifficultyToMaxTarget(d, maxTarget)`
 * followed by `Math.max(result, portMin)` is how `StratumV2Client`
 * gates OpenStandardMiningChannel / OpenExtendedMiningChannel /
 * UpdateChannel difficulty assignments. These tests lock in two
 * properties of that sequence (H1 of the signed-ledger audit):
 *
 *   1. "Floor holds": no matter what nominalHashRate / maxTarget the
 *      client supplies, the assigned difficulty is ≥ portMin.
 *   2. "Spec respected": the assigned difficulty's target never
 *      exceeds maxTarget, so SV2 spec §5.3.6 is not violated by the
 *      upward clamp.
 *
 * A miner whose maxTarget is "too hard" for our floor sees the second
 * invariant produce a difficulty > portMin (the maxTarget clamp wins);
 * a miner whose maxTarget is "too soft" sees the first invariant
 * produce portMin (and its shares at the suggested diff will fail
 * validation — correct pool-side behaviour for hardware below the
 * minimum).
 */
describe('DifficultyUtils port-floor invariants (SV2)', () => {

    /**
     * Mirror of the StratumV2Client gate: computeInitialDifficulty →
     * clampDifficultyToMaxTarget → Math.max(portMin).
     */
    function applyGate(
        rawDifficulty: number,
        maxTarget: Buffer,
        portMin: number,
    ): number {
        let d = DifficultyUtils.clampDifficultyToMaxTarget(rawDifficulty, maxTarget);
        if (portMin > 0 && d < portMin) d = portMin;
        return d;
    }

    function buildTargetForDifficulty(diff: number): Buffer {
        return DifficultyUtils.difficultyToTarget(diff);
    }

    const EASY_TARGET = Buffer.alloc(32, 0xff);   // trivially easy

    it('floor holds: low nominalHashRate with easy maxTarget cannot drop below portMin', () => {
        // Attack: SV2 client on PPLNS port sends nominalHashRate = 1 MH/s
        // (→ rawDifficulty ≈ 1) with an easy maxTarget. Pre-fix: channel
        // would open at diff 1. Post-fix: channel opens at diff 500.
        const result = applyGate(1, EASY_TARGET, 500);
        expect(result).toBe(500);
    });

    it('floor holds: zero rawDifficulty clamps up to portMin', () => {
        const result = applyGate(0, EASY_TARGET, 500);
        expect(result).toBeGreaterThanOrEqual(500);
    });

    it('hardware class: miner asking for a hard maxTarget gets HARDER than floor, not softer', () => {
        // ASIC-class miner declares maxTarget corresponding to diff 10 000
        // and nominalHashRate consistent with that. Gate should yield
        // 10 000 (from maxTarget clamp), NOT 500.
        const hardTarget = buildTargetForDifficulty(10_000);
        const result = applyGate(5_000 /* raw guess */, hardTarget, 500);
        expect(result).toBeGreaterThanOrEqual(10_000);
    });

    it('no floor configured: gate is a no-op for port without minimumDifficulty', () => {
        // Solo port (default): portMin = 0, client's nominalHashRate
        // determines difficulty freely.
        expect(applyGate(1, EASY_TARGET, 0)).toBe(1);
        expect(applyGate(50_000, EASY_TARGET, 0)).toBe(50_000);
    });

    it('spec respected: assigned difficulty never produces a target exceeding maxTarget', () => {
        // Property test: random combinations of rawDifficulty, portMin,
        // and maxTarget (as-if from diff N). Invariant: the assigned
        // target must be ≤ maxTarget (no spec violation).
        const trials: Array<[number, number, number]> = [
            [1, 500, 100],       // raw low, floor 500, maxTarget diff-100 easy
            [100, 500, 10_000],  // raw low, floor 500, maxTarget very hard
            [50_000, 500, 1_000],// raw high, floor 500, maxTarget medium
            [1, 1, 1],           // all trivial
            [10, 500, 500],      // maxTarget == floor
        ];
        for (const [rawDiff, floor, maxDiff] of trials) {
            const maxTarget = buildTargetForDifficulty(maxDiff);
            const assignedDiff = applyGate(rawDiff, maxTarget, floor);
            const assignedTarget = DifficultyUtils.difficultyToTarget(assignedDiff);

            // Convert both to BigInt for comparison.
            const assignedBig = assignedTarget
                .reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
            const maxBig = maxTarget
                .reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

            // SV2 §5.3.6: server MUST NOT exceed client's maxTarget.
            // Upward clamp to portMin might produce a harder-than-maxTarget
            // difficulty (smaller target) — that's allowed. Only softer
            // would be a violation.
            expect(assignedBig).toBeLessThanOrEqual(maxBig);
        }
    });

    it('meetsTarget: hash strictly less than target accepted, strictly greater rejected', () => {
        const target = DifficultyUtils.difficultyToTarget(1000);
        // Hash one less than target (LE) → meets
        const easy = Buffer.from(target);
        for (let i = 0; i < 32; i++) {
            if (easy[i] > 0) { easy[i]--; break; }
        }
        expect(DifficultyUtils.meetsTarget(easy, target)).toBe(true);
        // Hash one greater than target → fails
        const hard = Buffer.from(target);
        for (let i = 0; i < 32; i++) {
            if (hard[i] < 0xff) { hard[i]++; break; }
        }
        expect(DifficultyUtils.meetsTarget(hard, target)).toBe(false);
    });

    it('meetsTarget: hash equal to target accepted (boundary)', () => {
        const target = DifficultyUtils.difficultyToTarget(1000);
        expect(DifficultyUtils.meetsTarget(target, target)).toBe(true);
    });

    it('meetsTarget closes the float-precision gap that calculateDifficulty would miss', () => {
        // Repro of the production bug: a hash exactly at the assigned
        // target. difficultyToTarget(D) uses floor() → target is rounded
        // DOWN, slightly easier than ideal. A hash hitting this target
        // recomputes via TRUE_DIFF_ONE / hashAsBigInt to a difficulty
        // marginally BELOW D. The old `submissionDifficulty >= D` test
        // would reject the share (`difficulty-too-low`); meetsTarget
        // accepts it because hash ≤ target by construction.
        for (const diff of [931.31, 1024.0, 65536.5, 1_000_000]) {
            const target = DifficultyUtils.difficultyToTarget(diff);
            // Hash AT target → must accept
            expect(DifficultyUtils.meetsTarget(target, target)).toBe(true);
            // Recomputed difficulty round-trips slightly low (regression
            // guard: if this assertion ever changes, it means the float
            // boundary case can no longer occur and meetsTarget would be
            // unnecessary — both would still be a valid pool, but worth
            // re-evaluating the design then).
            const recomputed = DifficultyUtils.targetToDifficulty(target);
            expect(recomputed).toBeLessThanOrEqual(diff);
        }
    });

    /**
     * Pinned reference values originally produced by `big.js` (DP=80).
     * After removing big.js, calculateDifficulty / targetToDifficulty use
     * pure BigInt arithmetic; these guard against drift.
     */
    describe('TRUE_DIFF_ONE / divisor matches frozen big.js reference', () => {
        function encodeLeU256(n: bigint): Buffer {
            const buf = Buffer.alloc(32);
            let v = n;
            for (let i = 0; i < 32; i++) {
                buf[i] = Number(v & 0xffn);
                v >>= 8n;
            }
            return buf;
        }

        const cases: Array<{ divisor: bigint; expected: number }> = [
            { divisor: 26959535291011309493156476344723991336010898738574164086137773096960n, expected: 1 },
            { divisor: 269595352910113094931564763447239913360108987385741640861377730969n, expected: 100 },
            { divisor: 26314822148376095161694950068056604525144849915640960552599095263n, expected: 1024.5 },
            { divisor: 411363585318389756826776879392160021606281928354580833515995134n, expected: 65537 },
            { divisor: 26959535291011309493156476344723991336010898738574164086137773n, expected: 1000000 },
            { divisor: 336994191137641368664455954309049891700136234232177051n, expected: 80000000000000 },
        ];

        for (const { divisor, expected } of cases) {
            it(`divisor ≈ 2^${divisor.toString(2).length}b → ${expected}`, () => {
                const actual = DifficultyUtils.targetToDifficulty(encodeLeU256(divisor));
                const relErr = Math.abs(actual - expected) / expected;
                expect(relErr).toBeLessThan(1e-9);
            });
        }
    });

    /**
     * Fuzzer: 100 random 256-bit divisors. Re-derive the expected difficulty
     * locally via independent BigInt math (numerator * 1e15 / divisor scheme)
     * and compare against targetToDifficulty. Catches off-by-scale bugs.
     */
    it('fuzz: BigInt-ratio implementation stable across 100 random divisors', () => {
        const TRUE_DIFF_ONE_BIGINT = 26959535291011309493156476344723991336010898738574164086137773096960n;

        function encodeLeU256(n: bigint): Buffer {
            const buf = Buffer.alloc(32);
            let v = n;
            for (let i = 0; i < 32; i++) {
                buf[i] = Number(v & 0xffn);
                v >>= 8n;
            }
            return buf;
        }

        // Independent reference: scale numerator by 1e15, divide, then /1e15.
        // Different scale than the production impl (1e9) — drift between the
        // two would point to an arithmetic error rather than a rounding tie.
        function referenceRatio(divisor: bigint): number {
            const REF_SCALE = 1_000_000_000_000_000n;
            const REF_SCALE_NUM = 1e15;
            const scaled = (TRUE_DIFF_ONE_BIGINT * REF_SCALE) / divisor;
            return Number(scaled) / REF_SCALE_NUM;
        }

        for (let i = 0; i < 100; i++) {
            // Random 256-bit divisor, biased away from extreme tails so the
            // resulting Number is comfortably in IEEE 754 range.
            let divisor = 0n;
            for (let b = 0; b < 8; b++) {
                divisor = (divisor << 32n) | BigInt(Math.floor(Math.random() * 0x100000000));
            }
            // Keep divisor non-zero and below TRUE_DIFF_ONE * 1e9 so reference scale doesn't overflow Number sanity.
            if (divisor === 0n) divisor = 1n;

            const actual = DifficultyUtils.targetToDifficulty(encodeLeU256(divisor));
            const expected = referenceRatio(divisor);

            // expected can be Infinity/very-large for tiny divisors; use relative tolerance
            // and skip explicit-Infinity comparison.
            if (!Number.isFinite(expected) || expected === 0) continue;
            const relErr = Math.abs(actual - expected) / expected;
            expect(relErr).toBeLessThan(1e-6);
        }
    });

    it('spec respected: floor is ≥ portMin even when floor > maxTarget-equivalent', () => {
        // Miner on PPLNS port declares an "easier than floor" maxTarget.
        // The assigned difficulty is clamped UP to portMin (breaking the
        // miner's maxTarget preference — intentional, miner's hardware
        // is simply unfit for this port). Their shares will fail
        // validation; they disconnect. Same outcome SV1 produces.
        const softMaxTarget = buildTargetForDifficulty(100);
        const assignedDiff = applyGate(50 /* raw from low hashrate */, softMaxTarget, 500);
        expect(assignedDiff).toBe(500);
        // The assigned target IS smaller than softMaxTarget (since
        // diff 500 > diff 100). Miner's shares at their max-target
        // won't meet our diff 500 requirement — pool-side rejection,
        // not a spec violation.
        const assignedTarget = DifficultyUtils.difficultyToTarget(assignedDiff);
        const assignedBig = assignedTarget
            .reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
        const softBig = softMaxTarget
            .reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
        expect(assignedBig).toBeLessThan(softBig);
    });
});
