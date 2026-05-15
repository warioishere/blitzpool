import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

/**
 * Focused tests for the VarDiff floor that was added to support the
 * PPLNS port gate (PPLNS_MIN_DIFFICULTY). The existing hashrate /
 * retarget logic is covered implicitly by integration tests; here we
 * only lock in that the floor actually floors.
 */
describe('StratumV1ClientStatistics — minDifficulty floor', () => {

    /**
     * Populate the internal submission cache with N shares at a given
     * difficulty, spread over a 1-minute window so the retarget math
     * has both `sum` and `diffSeconds` to work with.
     */
    function feedShares(stats: StratumV1ClientStatistics, count: number, difficulty: number) {
        const start = Date.now() - 60_000;
        for (let i = 0; i < count; i++) {
            (stats as any).submissionCache.push({
                time: new Date(start + i * (60_000 / count)),
                difficulty,
            });
        }
    }

    it('suggested difficulty respects configured floor', () => {
        const stats = new StratumV1ClientStatistics(6, 500);
        // Tiny submission rate → natural target would be well below 1.
        // Floor should clamp to exactly 500.
        feedShares(stats, 30, 0.1);
        const suggested = stats.getSuggestedDifficulty(16384);
        expect(suggested).not.toBeNull();
        expect(suggested!).toBeGreaterThanOrEqual(500);
    });

    it('without a configured floor, suggestion can drop well below 500', () => {
        const stats = new StratumV1ClientStatistics(6);
        feedShares(stats, 30, 0.1);
        const suggested = stats.getSuggestedDifficulty(16384);
        expect(suggested).not.toBeNull();
        expect(suggested!).toBeLessThan(1);
    });

    it('floor of 0 falls back to the built-in default (bad-env guard)', () => {
        const stats = new StratumV1ClientStatistics(6, 0);
        feedShares(stats, 30, 0.1);
        const suggested = stats.getSuggestedDifficulty(16384);
        expect(suggested).not.toBeNull();
        expect(suggested!).toBeLessThan(1);
    });

    it('non-finite floor is rejected and default is used', () => {
        const stats = new StratumV1ClientStatistics(6, NaN);
        feedShares(stats, 30, 0.1);
        const suggested = stats.getSuggestedDifficulty(16384);
        expect(suggested).not.toBeNull();
        expect(suggested!).toBeLessThan(1);
    });
});

/**
 * After a vardiff ratchet, the in-flight wave of shares against pre-ratchet
 * jobs is credited at the OLD diff via the CK-style clamp. Those clamped
 * shares are real work for the hashrate display but MUST NOT enter the
 * vardiff submission cache — otherwise the rolling-window sum gets
 * polluted with old-diff entries and the next vardiff calc would chase
 * a target between the old and new diff, oscillating. Mirrors ckpool
 * stratifier.c:5781-5783 `if (diff != client->diff) ssdc=0; return;`.
 */
describe('StratumV1ClientStatistics — vardiff stale-diff gate', () => {
    it('current-diff shares enter the submission cache', () => {
        const stats = new StratumV1ClientStatistics(6);
        stats.updateHashRate(1024, true);
        expect((stats as any).submissionCache.length).toBe(1);
    });

    it('stale-diff shares are excluded from the submission cache', () => {
        const stats = new StratumV1ClientStatistics(6);
        stats.updateHashRate(256, false);  // CK-clamped, old diff
        stats.updateHashRate(256, false);
        stats.updateHashRate(256, false);
        expect((stats as any).submissionCache.length).toBe(0);
    });

    it('stale-diff shares still update live hashrate accumulators', () => {
        const stats = new StratumV1ClientStatistics(6);
        // First share establishes the time-slot baseline.
        stats.updateHashRate(1024, true);
        const cacheBefore = (stats as any).submissionCache.length;
        // Stale-diff burst should still drive the share counter — without
        // this, a quiet miner that only had stale shares for a window
        // would look dead in the live hashrate display.
        stats.updateHashRate(256, false);
        stats.updateHashRate(256, false);
        expect((stats as any).submissionCache.length).toBe(cacheBefore);  // no cache pollution
        expect((stats as any).shares).toBeGreaterThan(1024);  // hashrate share-sum advanced
    });
});
