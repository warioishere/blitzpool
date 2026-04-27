import { CoinbaseDistributionEntry } from './coinbase-distribution';

/**
 * Persistent snapshot of a coinbase distribution + matching ledger
 * deltas, stored in Redis between template-build and block-found so
 * that the eventual block-found bookkeeping uses the EXACT distribution
 * that went into the on-chain coinbase.
 *
 * Single source of truth for the snapshot shape — used by both
 * PplnsService (one snapshot per pool) and GroupSoloService (one
 * snapshot per (group, finderAddress)).
 *
 * Wire format is JSON; arrays are used instead of Map / Set so the
 * payload survives serialization. Use `readStoredSnapshot` to get the
 * Map / Set hydrated form back.
 */
export interface StoredCoinbaseSnapshot {
    distribution: CoinbaseDistributionEntry[];
    blockRewardSats: number;
    consideredAddresses: string[];
    /** Signed for PPLNS, always-positive for Group-Solo. Empty list = no ledger changes. */
    balanceAfter: Array<[string, number]>;
}

/**
 * Hydrated form of `StoredCoinbaseSnapshot`. consideredAddresses /
 * balanceAfter come back as Set / Map for ergonomic callsite use; the
 * distribution stays as an array because order matters for coinbase
 * output rendering.
 */
export interface ParsedCoinbaseSnapshot {
    distribution: CoinbaseDistributionEntry[];
    blockRewardSats: number;
    consideredAddresses: Set<string>;
    balanceAfter: Map<string, number>;
}

/**
 * Persist a snapshot under `key` with the given TTL. Tries `SET key val
 * EX ttl` first; falls back to `SET` + `EXPIRE` if the underlying Redis
 * client doesn't accept the options-object form (older ioredis builds).
 */
export async function writeStoredSnapshot(
    redis: any,
    key: string,
    snapshot: StoredCoinbaseSnapshot,
    ttlSeconds: number,
): Promise<void> {
    try {
        await redis.set(key, JSON.stringify(snapshot), { EX: ttlSeconds });
    } catch {
        await redis.set(key, JSON.stringify(snapshot));
        if (typeof redis.expire === 'function') {
            await redis.expire(key, ttlSeconds);
        }
    }
}

/**
 * Load + hydrate a snapshot, or return null if the key is missing or
 * the stored payload is unparseable.
 *
 * Backwards-compat: snapshots written before the signed-ledger rollout
 * lacked the per-entry `sats` field. They get a derived value
 * `floor(percent / 100 × blockRewardSats)` here so old snapshots that
 * survive across a deploy are still usable. New snapshots always carry
 * `sats` directly so this fallback is dead code in steady state.
 */
export async function readStoredSnapshot(
    redis: any,
    key: string,
): Promise<ParsedCoinbaseSnapshot | null> {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
        const parsed: StoredCoinbaseSnapshot = JSON.parse(raw);
        return {
            distribution: parsed.distribution.map(d => ({
                address: d.address,
                percent: d.percent,
                sats: d.sats ?? Math.floor((d.percent / 100) * parsed.blockRewardSats),
            })),
            blockRewardSats: parsed.blockRewardSats,
            consideredAddresses: new Set(parsed.consideredAddresses ?? []),
            balanceAfter: new Map(parsed.balanceAfter ?? []),
        };
    } catch {
        return null;
    }
}
