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
