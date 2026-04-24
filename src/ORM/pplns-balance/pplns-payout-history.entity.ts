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

    /**
     * Discriminator for row semantics:
     *   - 'coinbase'    : paid on-chain via the block's coinbase tx
     *   - 'pending'     : signed ledger change without an on-chain output
     *                     (sub-dust / weight-trimmed credit, or a debit
     *                     booked against a bonus-receiving miner — see
     *                     pplns_balance.balanceSats)
     *   - 'dust-sweep'  : absorbed by the daily sweep cron after inactivity
     *
     * Existing rows default to 'coinbase' via the migration backfill —
     * inCoinbase=true mapped to 'coinbase', inCoinbase=false mapped to
     * 'pending'. New code uses rowType; inCoinbase is kept for backward
     * compatibility but should be derived from rowType in new UI.
     */
    @Column({ type: 'varchar', length: 16, default: 'coinbase' })
    rowType: 'coinbase' | 'pending' | 'dust-sweep';

    @CreateDateColumn()
    createdAt: Date;
}
