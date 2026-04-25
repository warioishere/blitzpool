import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    dissolvedAt: Date | null;

    // ── Group-Solo round configuration ──────────────────────────────
    //
    // NULL = feature off (default). Set together by an admin via
    // PATCH /pplns/groups/:id/settings to enable timed round resets
    // and/or a finder bonus on top of the proportional split.

    /**
     * Days between scheduled timer-resets. NULL = no timer (only
     * block-found triggers a reset, original behaviour).
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
    @Column({ type: 'timestamptz', nullable: true })
    lastRoundResetAt: Date | null;

    /**
     * Absolute sats paid as a bonus to the block finder, on top of
     * their proportional share. NULL or 0 = no bonus. Capped at
     * runtime to 95 % of the miner cut so other members aren't
     * starved on small post-halving rewards.
     */
    @Column({ type: 'bigint', nullable: true,
        transformer: { to: (v: number | null) => v, from: (v: string | null) => v == null ? null : parseInt(v, 10) } })
    finderBonusSats: number | null;
}
