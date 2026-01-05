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
