import { BeforeInsert, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

/**
 * Member of a Blockparty group. The admin is also a member (with
 * role='admin'); regular members have role='member'.
 *
 * `percentBp` is the basis-points share of the *miner cut*
 * (= coinbase value minus pool fee). Sum of all members' percentBp
 * MUST equal 10000 (= 100% of the miner cut).
 *
 * `address` is globally unique — an address can only be in one
 * blockparty group at a time. Mode-collision against PPLNS /
 * Group-Solo is enforced at the service layer.
 */
@Entity('blockparty_member')
@Unique('UQ_blockparty_member_group_address', ['groupId', 'address'])
export class BlockpartyMemberEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 320 })
    email: string;

    /** Basis points: 100 = 1%, 10000 = 100%. Min 100 enforced in service. */
    @Column({ type: 'int' })
    percentBp: number;

    @Column({ type: 'varchar', length: 16, default: 'member' })
    role: 'admin' | 'member';

    /** Null until member accepts the invitation. Reset to null when admin edits splits. */
    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    confirmedAt: number | null;

    /**
     * SHA-256 of the member's persistent token, minted on first invitation
     * accept. Required for re-confirmations after admin %-edits and for
     * gated read access on the admin/detail page. Null until first accept.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    memberTokenHash: string | null;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    updatedAt: number;

    @BeforeInsert()
    private fillTimestamps(): void {
        const now = Date.now();
        if (this.createdAt == null) this.createdAt = now;
        if (this.updatedAt == null) this.updatedAt = now;
    }
}
