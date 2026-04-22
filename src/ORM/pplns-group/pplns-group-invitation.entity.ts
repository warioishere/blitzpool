import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Pending invitation for an address to join a payout group. Created by the
 * group admin; the address holder accepts (or declines) via a tokenized link
 * sent to the email bound to that address. Pending invitations do NOT make
 * the address a member — the address is only added to the group's
 * pplns_group_member table once the invitation is accepted.
 *
 * Status lifecycle: pending -> accepted | declined | expired.
 */
export type PplnsGroupInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

@Entity('pplns_group_invitation')
export class PplnsGroupInvitationEntity {

    @PrimaryColumn({ type: 'varchar', length: 64 })
    token: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    groupId: string;

    @Index()
    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 320 })
    email: string;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: PplnsGroupInvitationStatus;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp' })
    expiresAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    respondedAt: Date | null;
}
