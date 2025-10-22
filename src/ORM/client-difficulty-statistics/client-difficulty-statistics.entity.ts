import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Index(['address', 'clientName', 'slotTime'], { unique: true })
@Entity()
export class ClientDifficultyStatisticsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 62, type: 'varchar' })
  address: string;

  @Column({ length: 64, type: 'varchar', nullable: true })
  clientName: string | null;

  @Column({ type: 'integer' })
  slotTime: number;

  @Column({ type: 'real', default: 0 })
  maxDifficulty: number;
}
