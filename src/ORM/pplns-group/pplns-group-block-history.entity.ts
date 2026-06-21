// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { BeforeInsert, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

// Idempotency defense-in-depth: at most one history row per (group, block,
// address). onBlockFound upserts with ON CONFLICT DO NOTHING, so a crash
// mid-processing followed by restart can't double-write bookkeeping rows.
@Index('UQ_pplns_group_block_history_group_block_address', ['groupId', 'blockHeight', 'address'], { unique: true })
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

    /**
     * Discriminator for row semantics — see pplns_payout_history.rowType
     * for the full enum. Replaced the legacy `inCoinbase: boolean` column
     * (dropped in 1779000000000-DropInCoinbaseColumn) — `'pending'` and
     * `'dust-sweep'` are no longer overloaded onto a single false-value.
     */
    @Column({ type: 'varchar', length: 16, default: 'coinbase' })
    rowType: 'coinbase' | 'pending' | 'dust-sweep';

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @BeforeInsert()
    private fillCreatedAt(): void {
        if (this.createdAt == null) this.createdAt = Date.now();
    }
}
