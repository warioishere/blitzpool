import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Pending email-verification token. Created when a user submits an email for
 * an address; consumed when they click the link sent to that email. Expires
 * after a short window (default 24h) — the user has to re-submit if it lapses.
 */
@Entity('pplns_email_verification')
export class EmailVerificationEntity {

    @PrimaryColumn({ type: 'varchar', length: 64 })
    token: string;

    @Index()
    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 320 })
    email: string;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp' })
    expiresAt: Date;
}
