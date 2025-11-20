import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NtfySubscriptionsEntity } from './ntfy-subscriptions.entity';


@Injectable()
export class NtfySubscriptionsService {
    constructor(
        @InjectRepository(NtfySubscriptionsEntity)
        private ntfySubscriptions: Repository<NtfySubscriptionsEntity>
    ) {}

    async getOrCreateSubscription(address: string): Promise<NtfySubscriptionsEntity> {
        let subscription = await this.ntfySubscriptions.findOne({ where: { address } });
        if (!subscription) {
            subscription = await this.ntfySubscriptions.save({
                address,
                language: 'de',
                bestDiffNotificationsEnabled: true,
                deviceNotificationsEnabled: false,
                hourlyStatsEnabled: false,
                hourlyWorkersEnabled: false
            });
        }
        return subscription;
    }

    async updateLanguage(address: string, language: 'de' | 'en'): Promise<void> {
        await this.getOrCreateSubscription(address);
        await this.ntfySubscriptions.update({ address }, { language });
    }

    async updateDeviceNotifications(address: string, enabled: boolean): Promise<void> {
        await this.getOrCreateSubscription(address);
        await this.ntfySubscriptions.update({ address }, { deviceNotificationsEnabled: enabled });
    }

    async updateHourlyNotifications(
        address: string,
        enabled: boolean,
        showStats: boolean,
        showWorkers: boolean
    ): Promise<void> {
        await this.getOrCreateSubscription(address);
        await this.ntfySubscriptions.update(
            { address },
            {
                hourlyStatsEnabled: enabled && showStats,
                hourlyWorkersEnabled: enabled && showWorkers
            }
        );
    }

    async getHourlyEnabledAddresses(): Promise<NtfySubscriptionsEntity[]> {
        return await this.ntfySubscriptions
            .createQueryBuilder('sub')
            .where('sub.hourlyStatsEnabled = :true OR sub.hourlyWorkersEnabled = :true', { true: true })
            .getMany();
    }

    async getLanguage(address: string): Promise<'de' | 'en'> {
        const subscription = await this.ntfySubscriptions.findOne({ where: { address } });
        return subscription?.language ?? 'de';
    }

    async isDeviceNotificationsEnabled(address: string): Promise<boolean> {
        const subscription = await this.ntfySubscriptions.findOne({ where: { address } });
        return subscription?.deviceNotificationsEnabled ?? false;
    }
}
