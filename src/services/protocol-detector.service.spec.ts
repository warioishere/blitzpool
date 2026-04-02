jest.mock('node-telegram-bot-api', () => jest.fn());

import { recordConnectionFailure, isConnectionBanned } from './protocol-detector.service';

// Access the module-level Maps for cleanup between tests
// We need to reset state between tests since they're module-level singletons
function clearBanState() {
  // Call isConnectionBanned with expired entries to trigger cleanup,
  // and record failures with dummy IPs won't affect our test IPs
  // Instead, we rely on the 60s window expiry by using unique IPs per test
}

describe('Fail-Ban Rate Limiting', () => {
  // Use unique IPs per test to avoid state leakage
  let testIpCounter = 0;
  function uniqueIp(): string {
    return `::ffff:10.0.0.${++testIpCounter}`;
  }

  describe('recordConnectionFailure', () => {
    it('should not ban after fewer failures than threshold', () => {
      const ip = uniqueIp();
      // Default threshold is 5
      for (let i = 0; i < 4; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(false);
    });

    it('should ban after exceeding failure threshold', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 6; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('should ban exactly at threshold + 1', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 5; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(false);

      recordConnectionFailure(ip);
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('should not ban a different IP', () => {
      const badIp = uniqueIp();
      const goodIp = uniqueIp();

      for (let i = 0; i < 10; i++) {
        recordConnectionFailure(badIp);
      }

      expect(isConnectionBanned(badIp)).toBe(true);
      expect(isConnectionBanned(goodIp)).toBe(false);
    });

    it('should handle null/empty IP gracefully', () => {
      recordConnectionFailure('');
      recordConnectionFailure(null as any);
      recordConnectionFailure(undefined as any);
      // Should not throw
    });
  });

  describe('isConnectionBanned', () => {
    it('should return false for unknown IP', () => {
      expect(isConnectionBanned(uniqueIp())).toBe(false);
    });

    it('should return true for banned IP', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('banned IP should stay banned on repeated checks', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) {
        recordConnectionFailure(ip);
      }
      // Multiple checks should all return true
      expect(isConnectionBanned(ip)).toBe(true);
      expect(isConnectionBanned(ip)).toBe(true);
      expect(isConnectionBanned(ip)).toBe(true);
    });
  });
});
