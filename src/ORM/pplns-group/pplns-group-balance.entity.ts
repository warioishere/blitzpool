import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Pending/paid balances per (address, groupId). Composite PK — one address
 * can legitimately have rows for multiple groups historically (sequentially,
 * since pplns_group_member.address is globally unique at any one time).
 * Keying on address alone would let a new group's addPending mutate a
 * stale row from a prior group and leak money across group boundaries.
 */
@Entity('pplns_group_balance')
export class PplnsGroupBalanceEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    @Index()
    @PrimaryColumn({ type: 'uuid' })
    groupId: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    pendingSats: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalPaidSats: number;

    /**
     * Last accepted-share timestamp for this (address, groupId). Updated
     * by GroupSoloService.recordShare. Drives the dust-sweep cron —
     * rows under the dust limit whose share timestamp is > 30d stale
     * get absorbed (audit row in block history, balance row deleted).
     */
    @Column({ type: 'timestamptz', nullable: true })
    lastAcceptedShareAt: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
