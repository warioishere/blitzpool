import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';
import { PushSubscriptionType } from './push-subscription-type.enum';

@Entity()
@Index(['address', 'endpoint', 'subscriptionType'], { unique: true })
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

    @Index()
    @Column({
        type: 'varchar',
        length: 20,
        default: PushSubscriptionType.UNIFIED_PUSH
    })
    subscriptionType: PushSubscriptionType;

    @Column({ type: 'bigint', nullable: true })
    lastNotificationAt: number;

    @Column({ default: true })
    bestDiffNotificationsEnabled: boolean;

    @Column({ default: true })
    deviceNotificationsEnabled: boolean;

    @Column({ default: true })
    blockNotificationsEnabled: boolean;

    @Column({ default: true })
    networkDiffNotificationsEnabled: boolean;
}
