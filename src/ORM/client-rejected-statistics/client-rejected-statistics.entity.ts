import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Unique(['address', 'clientName', 'time', 'reason'])
@Index(['address', 'clientName', 'time'])
export class ClientRejectedStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 62, type: 'varchar' })
  address: string;

  @Column({ length: 64, type: 'varchar', default: '' })
  clientName: string;

  @Column({ type: 'integer' })
  time: number;

  @Column({ type: 'varchar' })
  reason: string;

  @Column({ type: 'real', default: 0 })
  count: number;

  @Column({ type: 'real', default: 0 })
  diff: number;
}
