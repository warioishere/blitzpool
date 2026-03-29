import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('pplns_payout_history')
export class PplnsPayoutHistoryEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'int' })
    blockHeight: number;

    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    paidSats: number;

    @Column({ type: 'real', default: 0 })
    percent: number;

    @Column({ type: 'boolean', default: true })
    inCoinbase: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
