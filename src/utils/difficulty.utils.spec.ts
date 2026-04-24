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
