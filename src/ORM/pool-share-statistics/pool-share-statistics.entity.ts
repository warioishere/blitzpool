import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class PoolShareStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  time: number;

  @Column({ type: 'real', default: 0 })
  accepted: number;

  @Column({ type: 'real', default: 0 })
  rejected: number;
}
