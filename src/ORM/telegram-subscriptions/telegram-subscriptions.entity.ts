import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class TelegramSubscriptionsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    telegramChatId: number;

    @Column({ default: true }) // <--- genau das hier ist wichtig!
    bestDiffNotificationsEnabled: boolean;

    @Column({ default: false })
    deviceNotificationsEnabled: boolean;

    @Column({ default: false })
    isDefault: boolean;

    @Column({ default: false })
    hourlyStatsEnabled: boolean;

    @Column({ default: false })
    hourlyWorkersEnabled: boolean;
}
