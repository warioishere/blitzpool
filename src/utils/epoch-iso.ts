/**
 * Convert a bigint epoch-ms timestamp (as stored in the post-1781000 schema)
 * back to an ISO-8601 string for API responses. Preserves the pre-bigint
 * external contract — clients consuming `/api/...` endpoints saw ISO strings
 * before the Date → bigint refactor and still expect them. Entity fields
 * themselves stay as `number` to keep the pg-types parseDate / TypeORM Date
 * hydration overhead off the hot path.
 *
 * Pass-through for null / undefined so endpoints can preserve "not yet set"
 * nullable timestamps (e.g. dissolvedAt, decidedAt, verifiedAt) without an
 * extra ternary at each call site.
 */
export function isoFromEpoch(epochMs: number | null | undefined): string | null {
    if (epochMs == null || !Number.isFinite(epochMs)) return null;
    return new Date(epochMs).toISOString();
}
