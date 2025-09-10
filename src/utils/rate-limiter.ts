export interface RateLimiterOptions {
  windowMs?: number;
  threshold?: number;
  blockMs?: number;
}

interface RateRecord {
  timestamps: number[];
  blockedUntil?: number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly blockMs: number;
  private readonly records = new Map<string, RateRecord>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.threshold = options.threshold ?? 5;
    this.blockMs = options.blockMs ?? 30 * 60_000;
  }

  recordDisconnect(ip: string) {
    if (!ip) {
      return;
    }
    const now = Date.now();
    const record = this.records.get(ip) ?? { timestamps: [] };
    record.timestamps = record.timestamps.filter(
      (ts) => now - ts <= this.windowMs,
    );
    record.timestamps.push(now);
    if (record.timestamps.length >= this.threshold) {
      record.blockedUntil = now + this.blockMs;
      record.timestamps = [];
    }
    this.records.set(ip, record);
  }

  isBlocked(ip: string): boolean {
    if (!ip) {
      return false;
    }
    const record = this.records.get(ip);
    if (!record || !record.blockedUntil) {
      return false;
    }
    const now = Date.now();
    if (now < record.blockedUntil) {
      return true;
    }
    delete record.blockedUntil;
    if (record.timestamps.length === 0) {
      this.records.delete(ip);
    } else {
      this.records.set(ip, record);
    }
    return false;
  }
}
