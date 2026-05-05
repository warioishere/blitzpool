import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Invitation for an address to join a payout group. Two flavours:
 *
 *   inviteType='directed' (original, two-phase admin-driven):
 *     Admin specifies address up front, system emails the bound address
 *     a token, recipient accepts/declines via tokenized link. The (address,
 *     email) columns hold the pre-bound recipient. One-shot — status
 *     transitions to 'accepted' or 'declined' on response.
 *
 *   inviteType='open' (admin-shareable link):
 *     Admin generates a TTL-limited token to share in a community channel.
 *     The (address, email) columns are NULL until acceptance. Multi-use:
 *     anyone with a verified email binding can claim it before the TTL
 *     expires. Acceptance does NOT mark the row 'accepted' — the row
 *     stays usable until TTL or manual revoke.
 *
 * Status lifecycle:
 *   directed: pending -> accepted | declined | expired
 *   open:     pending -> revoked | expired (no 'accepted' state)
 */
export type PplnsGroupInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
export type PplnsGroupInvitationType = 'directed' | 'open';

@Entity('pplns_group_invitation')
export class PplnsGroupInvitationEntity {

    @PrimaryColumn({ type: 'varchar', length: 64 })
    token: string;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index()
    @Column({ type: 'varchar', length: 62, nullable: true })
    address: string | null;

    @Column({ type: 'varchar', length: 320, nullable: true })
    email: string | null;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: PplnsGroupInvitationStatus;

    /**
     * 'directed' = pre-bound address+email, sent via email, one-shot.
     * 'open'     = no pre-bound address, shareable link, multi-use until TTL.
     * Default is 'directed' so existing rows (created before this column)
     * keep their original semantics on read.
     */
    @Column({ type: 'varchar', length: 16, default: 'directed' })
    inviteType: PplnsGroupInvitationType;

    /**
     * When true on an open invite, the public accept endpoint refuses to
     * auto-add the joiner — they have to go through the join-request flow
     * so the admin can vet them. Ignored for directed invites (the admin
     * already picked the address there). Defaults to false to preserve
     * pre-existing open-link semantics.
     */
    @Column({ type: 'boolean', default: false })
    approvalRequired: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp' })
    expiresAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    respondedAt: Date | null;
}
