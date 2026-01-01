import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Unique(['time'])
export class PoolShareStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
  time: number;

  @Column({ type: 'real', default: 0 })
  accepted: number;

  @Column({ type: 'real', default: 0 })
  rejected: number;
}
