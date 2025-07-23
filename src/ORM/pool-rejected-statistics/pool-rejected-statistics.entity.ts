import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Unique(['time', 'reason'])
export class PoolRejectedStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer' })
  time: number;

  @Column({ type: 'varchar' })
  reason: string;

  @Column({ type: 'real', default: 0 })
  count: number;
}
