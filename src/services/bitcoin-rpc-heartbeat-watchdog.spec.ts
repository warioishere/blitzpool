import { HeartbeatWatchdog } from './bitcoin-rpc.service';

// Synthetic-clock unit tests for the redis-pubsub sidecar heartbeat
// watchdog. The watchdog is pure (no timers, no I/O) so we feed it
// monotonic timestamps directly and assert state transitions.
//
// What we're protecting against in prod:
//   - sidecar container dies / hangs → no more heartbeats → pool would
//     silently miss block notifications. Watchdog flips to defensive
//     polling.
//   - sidecar recovers later → watchdog detects first heartbeat, logs
//     recovery once, returns to pure pub/sub.

describe('HeartbeatWatchdog', () => {
    const THRESHOLD_MS = 90_000;

    it('stays fresh while heartbeats are within threshold', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);

        expect(w.check(60_000)).toBe('fresh');
        expect(w.check(89_999)).toBe('fresh');
        expect(w.check(90_000)).toBe('fresh'); // boundary is inclusive
    });

    it('crosses to first-stale exactly once when threshold is exceeded', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);

        expect(w.check(90_001)).toBe('first-stale');
        expect(w.check(120_000)).toBe('still-stale');
        expect(w.check(150_000)).toBe('still-stale');
    });

    it('recordHeartbeat returns "recovered" only on the first heartbeat after staleness', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);

        w.check(95_000); // → first-stale
        expect(w.recordHeartbeat(96_000)).toBe('recovered');
        expect(w.recordHeartbeat(120_000)).toBe('normal');
        expect(w.recordHeartbeat(150_000)).toBe('normal');
    });

    it('returning heartbeats flip state back to fresh', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);

        w.check(95_000); // stale
        w.recordHeartbeat(96_000); // recover
        expect(w.check(100_000)).toBe('fresh');
        expect(w.check(180_000)).toBe('fresh'); // still within new threshold (96k + 90k = 186k)
    });

    it('post-recovery, a second staleness fires first-stale again', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);

        w.check(91_000); // stale #1
        w.recordHeartbeat(100_000); // recover

        // Threshold is measured from the last heartbeat (100k), so anything
        // up to 190k is fresh, beyond is stale.
        expect(w.check(190_000)).toBe('fresh');
        expect(w.check(190_001)).toBe('first-stale');
        expect(w.check(200_000)).toBe('still-stale');
    });

    it('msSinceLastHeartbeat tracks elapsed time relative to last beat', () => {
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 1_000);

        expect(w.msSinceLastHeartbeat(1_000)).toBe(0);
        expect(w.msSinceLastHeartbeat(31_000)).toBe(30_000);

        w.recordHeartbeat(60_000);
        expect(w.msSinceLastHeartbeat(60_000)).toBe(0);
        expect(w.msSinceLastHeartbeat(120_000)).toBe(60_000);
    });

    it('regression — check() after a long quiet period reports "still-stale" not "first-stale"', () => {
        // Real failure scenario: sidecar dies at t=0, watchdog ticks at
        // t=30s/60s/90s/120s. Only the t=120s tick (first one past the
        // 90s threshold) should warn; t=150s/180s/… are still-stale.
        const w = new HeartbeatWatchdog(THRESHOLD_MS, 0);
        expect(w.check(30_000)).toBe('fresh');
        expect(w.check(60_000)).toBe('fresh');
        expect(w.check(90_000)).toBe('fresh');
        expect(w.check(120_000)).toBe('first-stale');
        expect(w.check(150_000)).toBe('still-stale');
        expect(w.check(180_000)).toBe('still-stale');
        expect(w.check(210_000)).toBe('still-stale');
    });
});
