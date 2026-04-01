import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class BestDifficultyTrackerEntity extends TrackedEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'double precision' })
    bestDifficulty: number;

    @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    lastCheckedAt: number;
}
