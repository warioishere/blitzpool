// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { BeforeInsert, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

/**
 * User-initiated request to join a public payout group. Created by the
 * miner from the public directory (`/groups/public/:id`); the group admin
 * approves or rejects from the admin dashboard.
 *
 * The trust anchor is the same as for invitations — the requesting
 * address must have a verified email binding before a request is
 * accepted server-side. The email column snapshots that binding at
 * request time so the reject/approve notification reaches the same
 * address even if the user later rebinds.
 *
 * Status lifecycle: pending → approved | rejected | expired.
 *   approved → membership created, decidedAt + decidedByAdminTokenHash set
 *   rejected → no membership, decidedAt + decidedByAdminTokenHash set
 *   expired  → set by cron after a long staleness window
 */
export type PplnsGroupJoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

@Entity('pplns_group_join_request')
export class PplnsGroupJoinRequestEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index()
    @Column({ type: 'varchar', length: 62 })
    address: string;

    /** Email at time of request (snapshot of the verified binding). */
    @Column({ type: 'varchar', length: 320 })
    email: string;

    /** Optional message to the admin (max 500 chars enforced in service). */
    @Column({ type: 'text', nullable: true })
    message: string | null;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: PplnsGroupJoinRequestStatus;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    decidedAt: number | null;

    @BeforeInsert()
    private fillCreatedAt(): void {
        if (this.createdAt == null) this.createdAt = Date.now();
    }

    /**
     * SHA-256 of the admin token that decided this request. Audit trail —
     * never the raw token, so a DB dump can't be used to act on the group.
     */
    @Column({ type: 'varchar', length: 255, nullable: true })
    decidedByAdminTokenHash: string | null;
}
