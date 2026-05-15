import { ValueTransformer } from 'typeorm';

/**
 * Stored as `bigint` in Postgres. node-postgres delivers bigint as a
 * decimal string; `from` parses to a JS number (epoch ms — safely
 * < 2^53 until year 287,396). `to` is identity — services pass numbers
 * directly.
 *
 * Used by every former `Date`-typed column in the schema after the
 * 2026-05 bigint cleanup. Replaces the old `DateTimeTransformer`
 * which boxed every read into a `new Date(...)` allocation.
 */
export const epochMsTransformer: ValueTransformer = {
    to: (value: number | null | undefined): number | null | undefined => value,
    from: (value: string | null): number | null => (value == null ? null : parseInt(value, 10)),
};
