import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Per-mode, pool-wide hashrate aggregates. One row per
 * (payout-mode, 10-min time bucket) — incremented by every accepted share
 * after the stratum layer decides which mode routed it.
 *
 * Separate from `client_statistics` on purpose: that table tracks shares
 * per address/worker/session and can't answer "how much work was routed
 * to mode X in the last 7 days" without cross-referencing the PPLNS
 * window membership (which lags by hours after port switches — exactly
 * the bug this table fixes).
 *
 * Data is written at-share-time, so historical values are preserved
 * even after addresses move in and out of modes.
 */
@Entity('pool_mode_hashrate')
@Unique('UQ_pool_mode_hashrate_mode_time', ['mode', 'time'])
export class PoolModeHashrateEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ length: 16, type: 'varchar' })
    mode: 'solo' | 'pplns' | 'group-solo';

    /** 10-min bucket start, epoch-ms. */
    @Index()
    @Column({
        type: 'bigint',
        transformer: { to: (v: number) => v, from: (v: string) => parseInt(v, 10) },
    })
    time: number;

    /** Accumulated diff-1-weighted accepted share work inside this bucket. */
    @Column({ type: 'real', default: 0 })
    diff: number;
}
