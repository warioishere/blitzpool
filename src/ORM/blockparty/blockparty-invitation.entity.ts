import { BeforeInsert, Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

/**
 * Invitation for an address to join a Blockparty group. Directed-only
 * for v1: the admin specifies the prospective member's BTC address and
 * email up front. The system mints a one-shot bearer token that the
 * member presents at /api/blockparty/invite/:token to accept or decline.
 *
 * Status lifecycle: pending → accepted | declined | expired.
 *
 * Token is the primary key: knowledge of the token is the only
 * authentication an accepting member needs (out-of-band-delivered
 * secret), same as the existing PPLNS-group invitation flow.
 */
export type BlockpartyInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

@Entity('blockparty_invitation')
export class BlockpartyInvitationEntity {

    @PrimaryColumn({ type: 'varchar', length: 64 })
    token: string;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index()
    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 320 })
    email: string;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: BlockpartyInvitationStatus;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    expiresAt: number;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    respondedAt: number | null;

    @BeforeInsert()
    private fillCreatedAt(): void {
        if (this.createdAt == null) this.createdAt = Date.now();
    }
}
