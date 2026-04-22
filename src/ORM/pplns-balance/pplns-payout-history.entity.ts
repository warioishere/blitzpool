import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Idempotency defense-in-depth: at most one history row per (block, address).
// onBlockFound upserts with ON CONFLICT DO NOTHING, so a crash mid-processing
// followed by restart can't double-write bookkeeping rows or double-clear
// pending balances.
@Index('UQ_pplns_payout_history_block_address', ['blockHeight', 'address'], { unique: true })
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
