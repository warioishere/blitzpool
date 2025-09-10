import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Unique(['address', 'time', 'reason'])
export class ClientRejectedStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 62, type: 'varchar' })
  address: string;

  @Column({ type: 'integer' })
  time: number;

  @Column({ type: 'varchar' })
  reason: string;

  @Column({ type: 'real', default: 0 })
  count: number;

  @Column({ type: 'real', default: 0 })
  shares: number;
}
