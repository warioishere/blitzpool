/**
 * Mining Pool Constants
 * Centralized constants to avoid duplication across the codebase
 */

/**
 * Bitcoin difficulty-1 target
 * Used for hashrate calculations: hashrate = (shares * DIFFICULTY_1) / time_seconds
 */
export const DIFFICULTY_1 = 4294967296;

/**
 * Time slot duration in seconds (10 minutes)
 * Used for statistics aggregation windows
 */
export const SLOT_DURATION_SECONDS = 600;

/**
 * Time slot duration in milliseconds (10 minutes)
 * Used for time slot calculations
 */
export const SLOT_DURATION_MS = 1000 * 60 * 10;

/**
 * Redis key TTL in seconds (24 hours)
 * Statistics keys expire after 24 hours to prevent Redis memory bloat
 */
export const REDIS_STATISTICS_TTL = 86400;

/**
 * Upper sanity bound for any single-share difficulty value.
 *
 * Network difficulty is ~3.5e14 as of 2026. 1e15 (~3x current network) is far
 * above anything a real miner would ever see assigned. Anything beyond this is
 * either a misconfigured client (e.g. SV2 OpenChannel with absurdly small
 * maxTarget that forces clampDifficultyToMaxTarget into the e+50 range) or a
 * data-corruption attack. We refuse to assign such a difficulty to a channel
 * AND refuse to write such a value into the share-statistics Redis buckets.
 *
 * Postgres `pool_share_statistics.accepted/rejected` are `real` (max ~3.4e38),
 * so a single bucket accumulating values > 3.4e38 will block all flushes from
 * that point forward. 1e15 keeps us four orders of magnitude inside the
 * column type even after weeks of accumulation.
 */
export const MAX_REASONABLE_DIFFICULTY = 1e15;
