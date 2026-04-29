import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PushSubscriptionEntity } from './push-subscription.entity';
import { PushSubscriptionType } from './push-subscription-type.enum';

@Injectable()
export class PushSubscriptionService implements OnModuleInit {

    // In-memory presence cache: addresses that currently have at least one
    // push subscription. Read-only consumers (PushNotificationService) check
    // this before issuing a per-address SELECT. Without it, every Stratum
    // connect/disconnect event fired one DB roundtrip per address even when
    // no subscription existed for that address — observed >1 M calls / 14 d
    // against ~1 real subscriber.
    //
    // Mutators on this service keep the cache in lock-step. The cache only
    // tracks *presence* of a subscription, not its preferences/type — the
    // DB still owns the source of truth and is queried on actual send.
    //
    // Bootstrap is best-effort: if the initial DISTINCT query fails, the
    // cache stays "not ready" and consumers fall back to the original
    // DB-every-time path (correct, just unoptimised).
    private readonly addressesWithSubscriptions = new Set<string>();
    private cacheReady = false;

    constructor(
        @InjectRepository(PushSubscriptionEntity)
        private pushSubscriptionRepository: Repository<PushSubscriptionEntity>
    ) {}

    async onModuleInit(): Promise<void> {
        try {
            const rows = await this.pushSubscriptionRepository
                .createQueryBuilder('s')
                .select('DISTINCT s.address', 'address')
                .where('s."deletedAt" IS NULL')
                .getRawMany<{ address: string }>();
            for (const r of rows) {
                if (r?.address) this.addressesWithSubscriptions.add(r.address);
            }
            this.cacheReady = true;
            console.log(`[PushSubscriptionService] Presence cache loaded with ${this.addressesWithSubscriptions.size} address(es)`);
        } catch (error) {
            console.warn('[PushSubscriptionService] Presence cache bootstrap failed; falling back to per-call DB:', (error as Error).message);
            this.cacheReady = false;
        }
    }

    /**
     * Returns false only when the cache is ready AND the address has no
     * subscription. While the cache is still bootstrapping (or bootstrap
     * failed), returns true so callers fall back to the DB path that was
     * always correct.
     */
    public hasAnySubscription(address: string): boolean {
        if (!this.cacheReady) return true;
        return this.addressesWithSubscriptions.has(address);
    }

    /**
     * Returns the cached snapshot of addresses with at least one subscription,
     * or null if the cache isn't ready (caller should fall back to the DB).
     * The returned array is a copy — mutators on the service won't observe.
     */
    public getCachedAddressesWithSubscriptions(): string[] | null {
        if (!this.cacheReady) return null;
        return Array.from(this.addressesWithSubscriptions);
    }

    /**
     * Re-evaluates whether an address still has any subscription after a
     * delete-style mutation. Adds/removes from the cache accordingly.
     * Safe to call when cacheReady is false (no-op).
     */
    private async refreshAddressInCache(address: string): Promise<void> {
        if (!this.cacheReady || !address) return;
        try {
            const remaining = await this.pushSubscriptionRepository.count({ where: { address } });
            if (remaining > 0) {
                this.addressesWithSubscriptions.add(address);
            } else {
                this.addressesWithSubscriptions.delete(address);
            }
        } catch (error) {
            // Conservative on failure: keep address in cache so notifications
            // still go out via the DB path. We'd rather over-notify than miss.
            this.addressesWithSubscriptions.add(address);
            console.warn(`[PushSubscriptionService] refreshAddressInCache failed for ${address.substring(0, 12)}…:`, (error as Error).message);
        }
    }

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
            const saved = await this.pushSubscriptionRepository.save(subscription);
            // Already known to the cache (pre-existing row), but be defensive
            // in case the bootstrap missed it.
            this.addressesWithSubscriptions.add(address);
            return saved;
        } else {
            // Create new subscription with all notifications enabled by default
            const newSubscription = this.pushSubscriptionRepository.create({
                address,
                endpoint,
                platform,
                subscriptionType,
                bestDiffNotificationsEnabled: true,
                deviceNotificationsEnabled: true,
                blockNotificationsEnabled: true,
                networkDiffNotificationsEnabled: true
            });
            const saved = await this.pushSubscriptionRepository.save(newSubscription);
            this.addressesWithSubscriptions.add(address);
            return saved;
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
        await this.refreshAddressInCache(address);
    }

    /**
     * Delete all subscriptions for an address
     */
    public async deleteByAddress(address: string): Promise<void> {
        await this.pushSubscriptionRepository.delete({ address });
        // No remaining rows possible — drop directly without an extra count.
        if (this.cacheReady) this.addressesWithSubscriptions.delete(address);
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
        blockNotifications?: boolean,
        networkDiffNotifications?: boolean
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
        if (networkDiffNotifications !== undefined) {
            updates.networkDiffNotificationsEnabled = networkDiffNotifications;
        }

        console.log(`[PushSubscriptionService] Updating preferences for ${address.substring(0, 20)}... with:`, {
            bestDiffNotifications,
            deviceNotifications,
            blockNotifications,
            networkDiffNotifications,
            updates
        });

        const result = await this.pushSubscriptionRepository.update({ address, endpoint }, updates);

        console.log(`[PushSubscriptionService] Update result: affected=${result.affected}`);

        // Verify the update
        const updated = await this.pushSubscriptionRepository.findOne({ where: { address, endpoint } });
        if (updated) {
            console.log(`[PushSubscriptionService] After update: bestDiff=${updated.bestDiffNotificationsEnabled}, device=${updated.deviceNotificationsEnabled}, block=${updated.blockNotificationsEnabled}, networkDiff=${updated.networkDiffNotificationsEnabled}`);
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
        await this.refreshAddressInCache(address);
    }

    /**
     * Delete all subscriptions of a specific type for an address
     */
    public async deleteAllByType(
        address: string,
        subscriptionType: PushSubscriptionType
    ): Promise<void> {
        await this.pushSubscriptionRepository.delete({ address, subscriptionType });
        await this.refreshAddressInCache(address);
    }

    /**
     * Get Unified Push subscriptions with network difficulty notifications enabled
     */
    public async getUnifiedPushWithNetworkDiffNotifications(): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                subscriptionType: PushSubscriptionType.UNIFIED_PUSH,
                networkDiffNotificationsEnabled: true
            }
        });
    }

    /**
     * Get FCM subscriptions with network difficulty notifications enabled
     */
    public async getFcmWithNetworkDiffNotifications(): Promise<PushSubscriptionEntity[]> {
        return await this.pushSubscriptionRepository.find({
            where: {
                subscriptionType: PushSubscriptionType.FCM,
                networkDiffNotificationsEnabled: true
            }
        });
    }
}
