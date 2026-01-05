import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
//Index for getHashRateForSession
@Index(["address", "clientName", "sessionId"])
//Index for statistics save
@Index(["address", "clientName", "sessionId", "time"])
// UNIQUE constraint to prevent duplicates (required for INSERT OR REPLACE upsert logic)
@Unique(["address", "clientName", "sessionId", "time"])
export class ClientStatisticsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Index()
    @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    time: number;

    @Column({ type: 'real' })
    shares: number;

    @Column({ default: 0, type: 'integer' })
    acceptedCount: number;

    @Column({ default: 0, type: 'integer' })
    rejectedCount: number;

    @Column({ default: 0, type: 'integer' })
    rejectedJobNotFoundCount: number;

    @Column({ default: 0, type: 'real' })
    rejectedJobNotFoundDiff1: number;

    @Column({ default: 0, type: 'integer' })
    rejectedDuplicateShareCount: number;

    @Column({ default: 0, type: 'real' })
    rejectedDuplicateShareDiff1: number;

    @Column({ default: 0, type: 'integer' })
    rejectedLowDifficultyShareCount: number;

    @Column({ default: 0, type: 'real' })
    rejectedLowDifficultyShareDiff1: number;


}
