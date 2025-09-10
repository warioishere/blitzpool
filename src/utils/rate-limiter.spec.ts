import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('blocks IP after rapid disconnects', () => {
    const limiter = new RateLimiter({
      windowMs: 1000,
      threshold: 5,
      blockMs: 1000,
    });
    const ip = '1.2.3.4';
    for (let i = 0; i < 5; i++) {
      limiter.recordDisconnect(ip);
    }
    expect(limiter.isBlocked(ip)).toBe(true);
  });

  it('unblocks IP after block duration', () => {
    jest.useFakeTimers();
    const blockMs = 30 * 60 * 1000;
    const limiter = new RateLimiter({ windowMs: 1000, threshold: 1, blockMs });
    const ip = '5.6.7.8';
    limiter.recordDisconnect(ip);
    expect(limiter.isBlocked(ip)).toBe(true);
    jest.advanceTimersByTime(blockMs);
    expect(limiter.isBlocked(ip)).toBe(false);
    jest.useRealTimers();
  });
});
