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
 * Wire format is a Redis Hash with one field per scalar / array slot.
 * `readStoredSnapshot` hydrates back to Set / Map / array form.
 * Legacy JSON-blob snapshots (pre-Hash rollout, may survive 1h after a
 * deploy) are read transparently via a GET-fallback path.
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
 * Persist a snapshot under `key` with the given TTL.
 *
 * The previous JSON-blob format produced one big string per snapshot
 * and forced JSON.parse / JSON.stringify on every read/write. Hash
 * form replaces that with a flat field-per-scalar layout — no JSON
 * tree allocation either side.
 *
 * `del` before `hSet` guarantees the key has Hash type even if a
 * legacy JSON-blob (STRING type) is still occupying the slot from a
 * previous deploy. Otherwise the hSet would throw WRONGTYPE.
 */
export async function writeStoredSnapshot(
    redis: any,
    key: string,
    snapshot: StoredCoinbaseSnapshot,
    ttlSeconds: number,
): Promise<void> {
    const fields: Record<string, string> = {
        blockRewardSats: String(snapshot.blockRewardSats),
        consideredAddresses: snapshot.consideredAddresses.join('|'),
        distribution_count: String(snapshot.distribution.length),
        balanceAfter_count: String(snapshot.balanceAfter.length),
    };
    for (let i = 0; i < snapshot.distribution.length; i++) {
        const d = snapshot.distribution[i];
        fields[`d${i}_addr`] = d.address;
        fields[`d${i}_pct`] = String(d.percent);
        fields[`d${i}_sats`] = String(d.sats);
    }
    for (let i = 0; i < snapshot.balanceAfter.length; i++) {
        const entry = snapshot.balanceAfter[i];
        fields[`b${i}_addr`] = entry[0];
        fields[`b${i}_sats`] = String(entry[1]);
    }

    await redis.del(key);
    await redis.hSet(key, fields);
    if (typeof redis.expire === 'function') {
        await redis.expire(key, ttlSeconds);
    }
}

/**
 * Load + hydrate a snapshot, or return null if the key is missing or
 * the stored payload is unparseable.
 *
 * Reader has two paths:
 *   1. Hash (current): HGETALL + parse fields.
 *   2. Legacy JSON-blob fallback: if HGETALL returns empty or throws
 *      WRONGTYPE, fall back to GET + JSON.parse. This covers in-flight
 *      snapshots written by the pre-Hash deploy during the first hour
 *      after rollout (TTL = 1h). Can be deleted after one stable cycle.
 *
 * Backwards-compat for legacy JSON: snapshots written before the
 * signed-ledger rollout lacked per-entry `sats`. They get a derived
 * value `floor(percent / 100 × blockRewardSats)` so the few that
 * survive across the rollout are still usable.
 */
export async function readStoredSnapshot(
    redis: any,
    key: string,
): Promise<ParsedCoinbaseSnapshot | null> {
    let hash: Record<string, string> | null = null;
    try {
        hash = (await redis.hGetAll(key)) ?? null;
    } catch {
        // WRONGTYPE — key is a legacy JSON string; fall through to GET branch.
        hash = null;
    }

    if (hash && Object.keys(hash).length > 0) {
        try {
            return parseHashSnapshot(hash);
        } catch {
            return null;
        }
    }

    // Either key doesn't exist OR was a legacy JSON-blob; try GET + JSON.parse.
    try {
        const raw = await redis.get(key);
        if (!raw) return null;
        return parseLegacyJsonSnapshot(raw);
    } catch {
        return null;
    }
}

function parseHashSnapshot(h: Record<string, string>): ParsedCoinbaseSnapshot {
    const blockRewardSats = parseInt(h.blockRewardSats, 10);
    const distCount = parseInt(h.distribution_count, 10);
    const balCount = parseInt(h.balanceAfter_count, 10);

    const distribution: CoinbaseDistributionEntry[] = new Array(distCount);
    for (let i = 0; i < distCount; i++) {
        distribution[i] = {
            address: h[`d${i}_addr`],
            percent: parseFloat(h[`d${i}_pct`]),
            sats: parseInt(h[`d${i}_sats`], 10),
        };
    }

    const balanceAfter = new Map<string, number>();
    for (let i = 0; i < balCount; i++) {
        balanceAfter.set(h[`b${i}_addr`], parseInt(h[`b${i}_sats`], 10));
    }

    const consideredAddresses = new Set<string>(
        h.consideredAddresses ? h.consideredAddresses.split('|').filter(s => s.length > 0) : [],
    );

    return { distribution, blockRewardSats, consideredAddresses, balanceAfter };
}

function parseLegacyJsonSnapshot(raw: string): ParsedCoinbaseSnapshot | null {
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
