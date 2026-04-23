import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('pplns_balance')
export class PplnsBalanceEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    pendingSats: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalPaidSats: number;

    /**
     * Last accepted-share timestamp for this address (on the PPLNS path).
     * Updated by PplnsService.recordShare. Primary driver for the dust-
     * sweep cron: rows with pendingSats < 546 whose last_accepted_share_at
     * is older than DUST_SWEEP_DORMANT_DAYS get absorbed.
     *
     * Nullable because pre-existing rows at migration time have no
     * timestamp — those are treated as "active" until they eventually
     * update or get swept once they truly go inactive.
     */
    @Column({ type: 'timestamptz', nullable: true })
    lastAcceptedShareAt: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
