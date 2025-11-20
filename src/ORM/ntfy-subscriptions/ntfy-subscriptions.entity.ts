import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class NtfySubscriptionsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ length: 62, type: 'varchar', unique: true })
    address: string;

    @Column({ default: 'de' })
    language: 'de' | 'en';

    @Column({ default: true })
    bestDiffNotificationsEnabled: boolean;

    @Column({ default: false })
    deviceNotificationsEnabled: boolean;

    @Column({ default: false })
    hourlyStatsEnabled: boolean;

    @Column({ default: false })
    hourlyWorkersEnabled: boolean;
}
