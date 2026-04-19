import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('pplns_group_block_history')
export class PplnsGroupBlockHistoryEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index()
    @Column({ type: 'int' })
    blockHeight: number;

    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    paidSats: number;

    @Column({ type: 'real', default: 0 })
    percent: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    sharesInRound: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalSharesInRound: number;

    @Column({ type: 'boolean', default: true })
    inCoinbase: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
