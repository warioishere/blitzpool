import { BeforeInsert, BeforeUpdate, Column, Entity, PrimaryColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

/**
 * Binds an email address to a BTC mining address. Verified once via a token
 * sent to the email; the verification timestamp is then permanent until the
 * user re-binds. Required before an admin can invite the address into a
 * payout group.
 */
@Entity('pplns_address_email')
export class AddressEmailEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 320 })
    email: string;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    verifiedAt: number | null;

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

    @BeforeUpdate()
    private touchUpdatedAt(): void {
        this.updatedAt = Date.now();
    }
}
