import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

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

    @Column({ type: 'timestamp', nullable: true })
    verifiedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
