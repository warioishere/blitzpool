import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Index(['address', 'endpoint'], { unique: true })
export class PushSubscriptionEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'text' })
    endpoint: string;

    @Column({ default: 'unknown' })
    platform: string;

    @Column({ type: 'bigint', nullable: true })
    lastNotificationAt: number;

    @Column({ default: false })
    deviceNotificationsEnabled: boolean;

    @Column({ default: false })
    blockNotificationsEnabled: boolean;
}
