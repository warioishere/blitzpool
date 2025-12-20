import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PushSubscriptionEntity } from './push-subscription.entity';
import { PushSubscriptionType } from './push-subscription-type.enum';

@Injectable()
export class PushSubscriptionService {

    constructor(
        @InjectRepository(PushSubscriptionEntity)
        private pushSubscriptionRepository: Repository<PushSubscriptionEntity>
    ) {}

    /**
     * Create or update a push subscription (upsert)
     */
    public async createOrUpdate(
        address: string,
        endpoint: string,
        platform: string,
        subscriptionType: PushSubscriptionType = PushSubscriptionType.UNIFIED_PUSH
    ): Promise<PushSubscriptionEntity> {
        // Try to find existing subscription
        let subscription = await this.pushSubscriptionRepository.findOne({
            where: { address, endpoint, subscriptionType }
        });

        if (subscription) {
            // Update existing subscription
            subscription.platform = platform;
            return await this.pushSubscriptionRepository.save(subscription);
        } else {
            // Create new subscription with all notifications enabled by default
            const newSubscription = this.pushSubscriptionRepository.create({
                address,
                endpoint,
                platform,
                subscriptionType,
                bestDiffNotificationsEnabled: true,
                deviceNotificationsEnabled: true,
                blockNotificationsEnabled: true
            });
            return await this.pushSubscriptionRepository.save(newSubscription);
        }
    }

    /**
     * Delete subscription by address and endpoint (optionally by type)
     */
    public async delete(
        address: string,
        endpoint: string,
        subscriptionType?: PushSubscriptionType
    ): Promise<void> {
        const where: any = { address, endpoint };
        if (subscriptionType) {
            where.subscriptionType = subscriptionType;
        }
        await this.pushSubscriptionRepository.delete(where);
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
        bestDiffNotifications?: boolean,
        deviceNotifications?: boolean,
        blockNotifications?: boolean
    ): Promise<void> {
        const updates: any = {};
        if (bestDiffNotifications !== undefined) {
            updates.bestDiffNotificationsEnabled = bestDiffNotifications;
        }
        if (deviceNotifications !== undefined) {
            updates.deviceNotificationsEnabled = deviceNotifications;
        }
        if (blockNotifications !== undefined) {
            updates.blockNotificationsEnabled = blockNotifications;
        }

        console.log(`[PushSubscriptionService] Updating preferences for ${address.substring(0, 20)}... with:`, {
            bestDiffNotifications,
            deviceNotifications,
            blockNotifications,
            updates
        });

        const result = await this.pushSubscriptionRepository.update({ address, endpoint }, updates);

        console.log(`[PushSubscriptionService] Update result: affected=${result.affected}`);

        // Verify the update
        const updated = await this.pushSubscriptionRepository.findOne({ where: { address, endpoint } });
        if (updated) {
            console.log(`[PushSubscriptionService] After update: bestDiff=${updated.bestDiffNotificationsEnabled}, device=${updated.deviceNotificationsEnabled}, block=${updated.blockNotificationsEnabled}`);
        }
    }

    /**
     * Get subscriptions with best difficulty notifications enabled
     */
    public async getByAddressWithBestDiffNotifications(address: string): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: { address, bestDiffNotificationsEnabled: true }
        });
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

    /**
     * Get FCM subscriptions with best difficulty notifications enabled
     */
    public async getFcmByAddressWithBestDiffNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.FCM,
                bestDiffNotificationsEnabled: true
            }
        });
    }

    /**
     * Get FCM subscriptions with device notifications enabled
     */
    public async getFcmByAddressWithDeviceNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.FCM,
                deviceNotificationsEnabled: true
            }
        });
    }

    /**
     * Get FCM subscriptions with block notifications enabled
     */
    public async getFcmByAddressWithBlockNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.FCM,
                blockNotificationsEnabled: true
            }
        });
    }

    /**
     * Get Unified Push subscriptions with best difficulty notifications enabled
     */
    public async getUnifiedPushByAddressWithBestDiffNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.UNIFIED_PUSH,
                bestDiffNotificationsEnabled: true
            }
        });
    }

    /**
     * Get Unified Push subscriptions with device notifications enabled
     */
    public async getUnifiedPushByAddressWithDeviceNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.UNIFIED_PUSH,
                deviceNotificationsEnabled: true
            }
        });
    }

    /**
     * Get Unified Push subscriptions with block notifications enabled
     */
    public async getUnifiedPushByAddressWithBlockNotifications(
        address: string
    ): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                address,
                subscriptionType: PushSubscriptionType.UNIFIED_PUSH,
                blockNotificationsEnabled: true
            }
        });
    }

    /**
     * Delete invalid FCM token
     */
    public async deleteInvalidFcmToken(address: string, token: string): Promise<void> {
        await this.pushSubscriptionRepository.delete({
            address,
            endpoint: token,
            subscriptionType: PushSubscriptionType.FCM
        });
    }

    /**
     * Delete all subscriptions of a specific type for an address
     */
    public async deleteAllByType(
        address: string,
        subscriptionType: PushSubscriptionType
    ): Promise<void> {
        await this.pushSubscriptionRepository.delete({ address, subscriptionType });
    }
}
