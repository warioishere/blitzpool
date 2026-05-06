export enum eStratumErrorCode {
    'OtherUnknown' = 20,
    'JobNotFound' = 21,
    'DuplicateShare' = 22,
    'LowDifficultyShare' = 23,
    'UnauthorizedWorker' = 24,
    'NotSubscribed' = 25,
}

/**
 * Internal-only rejection-reason strings used by the statistics layer.
 * On the wire we still emit error code 21 in both cases (Stratum V1 has
 * no separate "stale" code), but we record distinct counters so
 * operators can tell apart:
 *
 *   - `STRATUM_REJECT_STALE`: miner submitted against a job we retired
 *     within the last few seconds (or beyond grace, but the job is still
 *     in our map). Healthy at every block transition; a few per block
 *     is normal.
 *
 *   - `'JobNotFound'` (the enum name above): miner submitted against a
 *     jobId we have no record of. Should be effectively zero in steady
 *     state — only reachable after the 10-min retention window has GC'd
 *     the entry, which means either the miner sat on a job for 10
 *     minutes or there's a real bug.
 */
export const STRATUM_REJECT_STALE = 'Stale';