import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('pplns_group_balance')
export class PplnsGroupBalanceEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    pendingSats: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalPaidSats: number;

    @UpdateDateColumn()
    updatedAt: Date;
}
