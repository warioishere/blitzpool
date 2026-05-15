jest.mock('node-telegram-bot-api', () => jest.fn());

import {
  recordConnectionFailure,
  isConnectionBanned,
  _setBanRedisClient,
  _refreshBanCache,
} from './protocol-detector.service';

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
      // Default threshold is 10 (in-memory fallback path)
      for (let i = 0; i < 9; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(false);
    });

    it('should ban after exceeding failure threshold', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 11; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('should ban exactly at threshold + 1', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(false);

      recordConnectionFailure(ip);
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('should not ban a different IP', () => {
      const badIp = uniqueIp();
      const goodIp = uniqueIp();

      for (let i = 0; i < 15; i++) {
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
      for (let i = 0; i < 15; i++) {
        recordConnectionFailure(ip);
      }
      expect(isConnectionBanned(ip)).toBe(true);
    });

    it('banned IP should stay banned on repeated checks', () => {
      const ip = uniqueIp();
      for (let i = 0; i < 15; i++) {
        recordConnectionFailure(ip);
      }
      // Multiple checks should all return true
      expect(isConnectionBanned(ip)).toBe(true);
      expect(isConnectionBanned(ip)).toBe(true);
      expect(isConnectionBanned(ip)).toBe(true);
    });
  });

  describe('_refreshBanCache pipelined TTL reads', () => {
    afterEach(() => {
      _setBanRedisClient(null);
    });

    it('issues one pipeline call per batch instead of N sequential TTL awaits', async () => {
      const keys = Array.from({ length: 250 }, (_, i) => `failban:ban:1.2.3.${i}`);
      const ttlSpy = jest.fn();
      const execSpy = jest.fn(async () => keys.map(() => 3600));
      const mockMulti = () => {
        const chain: any = {};
        chain.ttl = (k: string) => { ttlSpy(k); return chain; };
        chain.exec = execSpy;
        return chain;
      };
      const redisClient: any = {
        scan: jest.fn(async () => ({ cursor: '0', keys })),
        ttl: jest.fn(),
        multi: jest.fn(mockMulti),
      };

      _setBanRedisClient(redisClient);
      await _refreshBanCache();

      // Old code path called .ttl() per key sequentially. New path calls it
      // via .multi().ttl() and a single .exec() — never on the raw client.
      expect(redisClient.ttl).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(ttlSpy).toHaveBeenCalledTimes(250);
    });

    it('batches at 500 keys/pipeline so a botnet-scale refresh stays bounded', async () => {
      const keys = Array.from({ length: 1234 }, (_, i) => `failban:ban:9.9.9.${i}`);
      const execSpy = jest.fn(async () => keys.slice(0, 500).map(() => 60));
      const redisClient: any = {
        scan: jest.fn(async () => ({ cursor: '0', keys })),
        ttl: jest.fn(),
        multi: jest.fn(() => ({
          ttl: () => ({ ttl: () => ({ ttl: () => ({ exec: execSpy }) }) }) as any,
        })),
      };
      // Build a proper chainable mock instead.
      const mkMulti = () => {
        const chain: any = {};
        chain.ttl = (_k: string) => chain;
        chain.exec = execSpy;
        return chain;
      };
      redisClient.multi = jest.fn(mkMulti);

      _setBanRedisClient(redisClient);
      await _refreshBanCache();

      // 1234 keys / 500 batch = ceil → 3 pipeline round-trips.
      expect(redisClient.multi).toHaveBeenCalledTimes(3);
    });
  });
});
