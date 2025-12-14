import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class BestDifficultyTrackerEntity extends TrackedEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'real' })
    bestDifficulty: number;

    @Column({ type: 'bigint' })
    lastCheckedAt: number;
}
