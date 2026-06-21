// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { BeforeInsert, BeforeUpdate, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

@Entity('pplns_group')
export class PplnsGroupEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 64 })
    name: string;

    @Column({ type: 'varchar', length: 62 })
    creatorAddress: string;

    @Column({ type: 'varchar', length: 255 })
    adminTokenHash: string;

    @Column({ type: 'boolean', default: false })
    active: boolean;

    /**
     * When true, the group is listed in the public directory at
     * `/pplns/groups/public` and accepts unsolicited join-requests. The
     * admin opts into this — default is false, so pre-existing groups
     * (created before this column was added) stay private until they
     * explicitly enable visibility.
     */
    @Column({ type: 'boolean', default: false })
    isPublic: boolean;

    /**
     * When true, the Group-Solo round (share window) is wiped on every
     * block-found. Default false: shares accumulate across blocks until a
     * calendar preset or manual reset fires — each block during the round
     * pays the full reward split by the accumulated shares. Per-finder
     * coinbase snapshots are always dropped on block-found regardless.
     */
    @Column({ type: 'boolean', default: false })
    resetRoundOnBlock: boolean;

    /**
     * Hard cap on member count. NULL = no limit. When set, every add-member
     * path is rejected once the group already has this many members (enforced
     * in GroupService.addMemberWithoutAdmin).
     */
    @Column({ type: 'int', nullable: true })
    maxMembers: number | null;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    updatedAt: number;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    dissolvedAt: number | null;

    // ── Group-Solo round configuration ──────────────────────────────
    //
    // NULL = feature off (default). Set together by an admin via
    // PATCH /pplns/groups/:id/settings to enable timed round resets
    // and/or a finder bonus on top of the proportional split.

    /**
     * Reset cadence preset:
     *   - 'daily'   → every day at 00:00 in admin's TZ (= end of previous day)
     *   - 'weekly'  → every Monday at 00:00 in admin's TZ (= end of Sunday)
     *   - 'monthly' → 1st of every month at 00:00 in admin's TZ (= end of month)
     *   - 'custom'  → every `roundResetIntervalDays` calendar days at 00:00 in TZ
     *   - null      → no scheduled reset (only block-found triggers a wipe)
     *
     * Stored as the authoritative source-of-truth for cadence; the older
     * `roundResetIntervalDays` is now only meaningful when preset='custom'.
     * Existing groups that pre-date this column have NULL preset and are
     * treated as 'custom' if `roundResetIntervalDays` is set.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    roundResetPreset: 'daily' | 'weekly' | 'monthly' | 'custom' | null;

    /**
     * Days between scheduled timer-resets. Only authoritative when
     * `roundResetPreset='custom'`. NULL = no timer (only block-found
     * triggers a reset, original behaviour).
     */
    @Column({ type: 'int', nullable: true })
    roundResetIntervalDays: number | null;

    /**
     * Hour-of-day (0-23) for the scheduled reset, in the group's
     * configured timezone. Pairs with roundResetTimezone.
     */
    @Column({ type: 'int', nullable: true })
    roundResetHourLocal: number | null;

    /**
     * IANA timezone string (e.g. 'Europe/Berlin'). Used by the cron
     * scheduler so resets fire at the same wall-clock time year-round
     * including across DST transitions.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    roundResetTimezone: string | null;

    /**
     * Set every time scheduledRoundReset() runs successfully. Used
     * to skip a redundant scheduled-reset firing right after a
     * block-found wipe in the same minute.
     */
    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    lastRoundResetAt: number | null;

    /**
     * Absolute sats paid as a bonus to the block finder, on top of
     * their proportional share. NULL or 0 = no bonus. Capped at
     * runtime to 95 % of the miner cut so other members aren't
     * starved on small post-halving rewards.
     */
    @Column({ type: 'bigint', nullable: true,
        transformer: { to: (v: number | null) => v, from: (v: string | null) => v == null ? null : parseInt(v, 10) } })
    finderBonusSats: number | null;

    @BeforeInsert()
    private fillTimestamps(): void {
        const now = Date.now();
        if (this.createdAt == null) this.createdAt = now;
        if (this.updatedAt == null) this.updatedAt = now;
    }

    @BeforeUpdate()
    private touchUpdatedAt(): void {
        this.updatedAt = Date.now();
    }
}
