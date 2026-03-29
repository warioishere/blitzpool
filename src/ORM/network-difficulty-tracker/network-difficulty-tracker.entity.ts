import { Column, Entity, PrimaryColumn, Check } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

/**
 * Network difficulty tracker - singleton entity to track Bitcoin network difficulty changes
 * Only one record should exist with id=1
 */
@Entity()
@Check('"id" = 1')
export class NetworkDifficultyTrackerEntity extends TrackedEntity {

    @PrimaryColumn({ type: 'integer', default: 1 })
    id: number;

    @Column({ type: 'double precision' })
    currentDifficulty: number;

    @Column({ type: 'double precision', nullable: true })
    previousDifficulty: number;

    @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    lastCheckedAt: number;

    @Column({ type: 'bigint', nullable: true, transformer: { to: (value: number | null) => value, from: (value: string | null) => value !== null ? parseInt(value, 10) : null } })
    lastChangedAt: number;
}
