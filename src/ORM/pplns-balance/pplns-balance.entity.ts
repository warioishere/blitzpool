import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('pplns_balance')
export class PplnsBalanceEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    pendingSats: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalPaidSats: number;

    @UpdateDateColumn()
    updatedAt: Date;
}
