import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PushSubscriptionEntity } from './push-subscription.entity';

@Injectable()
export class PushSubscriptionService {

    constructor(
        @InjectRepository(PushSubscriptionEntity)
        private pushSubscriptionRepository: Repository<PushSubscriptionEntity>
    ) {}

    /**
     * Create or update a push subscription (upsert)
     */
    public async createOrUpdate(address: string, endpoint: string, platform: string): Promise<PushSubscriptionEntity> {
        // Try to find existing subscription
        let subscription = await this.pushSubscriptionRepository.findOne({
            where: { address, endpoint }
        });

        if (subscription) {
            // Update existing subscription
            subscription.platform = platform;
            return await this.pushSubscriptionRepository.save(subscription);
        } else {
            // Create new subscription
            const newSubscription = this.pushSubscriptionRepository.create({
                address,
                endpoint,
                platform
            });
            return await this.pushSubscriptionRepository.save(newSubscription);
        }
    }

    /**
     * Delete subscription by address and endpoint
     */
    public async delete(address: string, endpoint: string): Promise<void> {
        await this.pushSubscriptionRepository.delete({ address, endpoint });
    }

    /**
     * Delete all subscriptions for an address
     */
    public async deleteByAddress(address: string): Promise<void> {
        await this.pushSubscriptionRepository.delete({ address });
    }

    /**
     * Get all subscriptions for an address
     */
    public async getByAddress(address: string): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: { address }
        });
    }

    /**
     * Get all unique addresses with subscriptions
     */
    public async getAddressesWithSubscriptions(): Promise<string[]> {
        const result = await this.pushSubscriptionRepository
            .createQueryBuilder('subscription')
            .select('DISTINCT subscription.address', 'address')
            .getRawMany();

        return result.map(row => row.address);
    }

    /**
     * Update last notification timestamp
     */
    public async updateLastNotification(id: number, timestamp: number): Promise<void> {
        await this.pushSubscriptionRepository.update({ id }, { lastNotificationAt: timestamp });
    }

    /**
     * Update notification preferences for a subscription
     */
    public async updateNotificationPreferences(
        address: string,
        endpoint: string,
        deviceNotifications?: boolean,
        blockNotifications?: boolean
    ): Promise<void> {
        const updates: any = {};
        if (deviceNotifications !== undefined) {
            updates.deviceNotificationsEnabled = deviceNotifications;
        }
        if (blockNotifications !== undefined) {
            updates.blockNotificationsEnabled = blockNotifications;
        }

        await this.pushSubscriptionRepository.update({ address, endpoint }, updates);
    }

    /**
     * Get subscriptions with device notifications enabled
     */
    public async getByAddressWithDeviceNotifications(address: string): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: { address, deviceNotificationsEnabled: true }
        });
    }

    /**
     * Get subscriptions with block notifications enabled
     */
    public async getByAddressWithBlockNotifications(address: string): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: { address, blockNotificationsEnabled: true }
        });
    }
}
