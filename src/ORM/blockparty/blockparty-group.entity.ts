// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { BeforeInsert, BeforeUpdate, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

export type BlockpartyStatus = 'draft' | 'confirming' | 'ready' | 'active' | 'dissolved';

/**
 * Blockparty group: loot-split mechanism for pooled hashpower rentals.
 * Coinbase splits per admin-set fixed percentages (basis points),
 * independent of who contributed how much hashpower.
 *
 * Lifecycle is share-driven (READY → ACTIVE on first share to
 * adminAddress) and admin-driven (DISSOLVED via Dissolve button,
 * gated by 24h hashrate-silence cooldown).
 */
@Entity('blockparty_group')
export class BlockpartyGroupEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 64 })
    name: string;

    /**
     * Treasury BTC address — the mining target. Hashrate routed to this
     * address triggers Blockparty mode (address-driven mode-detect on
     * solo port 3333). One blockparty per admin address (active or
     * dissolved is fine, but a second active one with the same admin
     * address would collide on mode-detect).
     */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 62 })
    adminAddress: string;

    /** SHA-256 of the admin token — shown once on create, never stored raw. */
    @Column({ type: 'varchar', length: 64 })
    adminTokenHash: string;

    @Column({ type: 'varchar', length: 16, default: 'draft' })
    status: BlockpartyStatus;

    /**
     * Updated on every accepted share whose miner address equals
     * adminAddress. Drives the 24h dissolve cooldown.
     */
    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    lastShareAt: number | null;

    /**
     * Optional admin-set rental-provider hint shown on the public detail
     * page (e.g. "MRR", "Braiins Hashrate", "Nicehash"). Pure UI metadata —
     * no backend semantics.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    rentalProviderHint: string | null;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    createdAt: number;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    updatedAt: number;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    dissolvedAt: number | null;

    @BeforeInsert()
    private fillTimestamps(): void {
        const now = Date.now();
        if (this.createdAt == null) this.createdAt = now;
        if (this.updatedAt == null) this.updatedAt = now;
    }

    @BeforeUpdate()
    private touchUpdatedAt(): void {
        this.updatedAt = Date.now();
    }
}
