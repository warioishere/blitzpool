import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Unique(['address', 'time', 'reason'])
export class ClientRejectedStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 62, type: 'varchar' })
  address: string;

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
  time: number;

  @Column({ type: 'varchar' })
  reason: string;

  @Column({ type: 'real', default: 0 })
  count: number;

  @Column({ type: 'real', default: 0 })
  shares: number;
}
