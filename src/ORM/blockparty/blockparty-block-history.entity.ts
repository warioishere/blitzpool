import { BeforeInsert, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

export interface BlockpartySplitSnapshot {
    address: string;
    percentBp: number;
    sats: number;
    /** True if this member's payout was rolled into the pool-fee output because of dust or weight-budget trim. */
    trimmed?: boolean;
}

/**
 * Found-block history for a Blockparty group. One row per block —
 * the per-member breakdown is captured atomically in `splits` (jsonb)
 * because Blockparty has no balance/pending ledger: payouts go straight
 * into the coinbase, history is read-only audit trail.
 *
 * Idempotency: unique on (groupId, blockHash). onBlockFound upserts with
 * ON CONFLICT DO NOTHING so a crash-restart can't double-write.
 */
@Index('UQ_blockparty_block_history_group_hash', ['groupId', 'blockHash'], { unique: true })
@Entity('blockparty_block_history')
export class BlockpartyBlockHistoryEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index()
    @Column({ type: 'int' })
    blockHeight: number;

    @Column({ type: 'varchar', length: 64 })
    blockHash: string;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    foundAt: number;

    @Column({ type: 'bigint', transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    coinbaseValueSats: number;

    @Column({ type: 'bigint', transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    poolFeeSats: number;

    @Column({ type: 'jsonb' })
    splits: BlockpartySplitSnapshot[];

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @BeforeInsert()
    private fillCreatedAt(): void {
        if (this.createdAt == null) this.createdAt = Date.now();
    }
}
