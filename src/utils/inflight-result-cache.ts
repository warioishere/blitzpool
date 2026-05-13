/**
 * Per-key result cache with TTL + in-flight-promise dedup. Replaces the
 * hand-rolled cache+inflight state every payout-engine had:
 *
 *   private cachedX: V | null = null;
 *   private cachedXKey = ''; private cachedXAt = 0;
 *   private inflightBuild: Promise<V> | null = null;
 *   private inflightBuildKey = '';
 *
 *   if (cached match && fresh)  return cached;
 *   if (inflight match)         return inflight;
 *   const p = build();          inflight = p;
 *   try result; set cached;     finally inflight = null;
 *
 * Used by PplnsService and GroupSoloService to deduplicate concurrent
 * getPayoutDistribution calls during the per-template fan-out across N
 * stratum sessions. K is whatever cache key the caller composes from
 * (group, finder, reward) etc.
 */
export class InflightResultCache<K, V> {
    private cached = new Map<K, { value: V; expiresAt: number }>();
    private inflight = new Map<K, Promise<V>>();

    constructor(private readonly ttlMs: number) {}

    async getOrCompute(key: K, build: () => Promise<V>): Promise<V> {
        const now = Date.now();
        const c = this.cached.get(key);
        if (c && c.expiresAt > now) {
            return c.value;
        }
        const inflight = this.inflight.get(key);
        if (inflight) {
            return inflight;
        }
        const promise = build()
            .then(v => {
                this.cached.set(key, { value: v, expiresAt: Date.now() + this.ttlMs });
                return v;
            })
            .finally(() => {
                if (this.inflight.get(key) === promise) {
                    this.inflight.delete(key);
                }
            });
        this.inflight.set(key, promise);
        return promise;
    }

    /** Get the cached value without computing; null if missing or stale. */
    peek(key: K): V | null {
        const c = this.cached.get(key);
        if (!c) return null;
        if (c.expiresAt <= Date.now()) {
            this.cached.delete(key);
            return null;
        }
        return c.value;
    }

    /**
     * Invalidate cached entries. With no arg: clear all. With a key: drop
     * that one. With a predicate: drop everything matching.
     */
    invalidate(target?: K | ((key: K) => boolean)): void {
        if (target === undefined) {
            this.cached.clear();
            return;
        }
        if (typeof target === 'function') {
            const pred = target as (k: K) => boolean;
            for (const k of this.cached.keys()) {
                if (pred(k)) this.cached.delete(k);
            }
            return;
        }
        this.cached.delete(target);
    }
}
