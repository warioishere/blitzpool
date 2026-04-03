import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Cumulative per-worker share totals.
 * Survives deleteOldStatistics cleanup of client_statistics_entity.
 */
@Entity()
@Index(['address'])
export class WorkerSharesEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @PrimaryColumn({ type: 'varchar' })
    clientName: string;

    @Column({ type: 'double precision', default: 0 })
    shares: number;

    @Column({ type: 'double precision', default: 0 })
    rejectedShares: number;
}
