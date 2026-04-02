import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PushSubscriptionEntity } from './push-subscription.entity';

@Injectable()
export class PushSubscriptionCleanupService implements OnModuleInit {
    private cleanupEnabled: boolean;
    private staleThresholdDays: number;

    constructor(
        @InjectRepository(PushSubscriptionEntity)
        private pushSubscriptionRepository: Repository<PushSubscriptionEntity>,
        private readonly configService: ConfigService,
    ) {
        this.cleanupEnabled = (this.configService.get('PUSH_SUBSCRIPTION_CLEANUP_ENABLED')?.toLowerCase() === 'true') ?? true;
        this.staleThresholdDays = Number(this.configService.get('PUSH_SUBSCRIPTION_STALE_DAYS')) || 90;
    }

    async onModuleInit(): Promise<void> {
        if (!this.cleanupEnabled) {
            console.log('[PushSubscriptionCleanup] Disabled via PUSH_SUBSCRIPTION_CLEANUP_ENABLED config');
            return;
        }

        console.log(`[PushSubscriptionCleanup] Enabled`);
        console.log(`[PushSubscriptionCleanup] Stale threshold: ${this.staleThresholdDays} days`);
    }

    /**
     * Run cleanup once per week (Sunday at 2 AM UTC)
     * Removes stale push subscriptions with no activity for configured threshold
     */
    @Cron('0 2 * * 0')
    async cleanupStaleSubscriptions(): Promise<void> {
        if (!this.cleanupEnabled) {
            return;
        }

        try {
            console.log(`[PushSubscriptionCleanup] Starting cleanup job...`);

            // Calculate cutoff date (X days ago)
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - this.staleThresholdDays);

            // Find subscriptions with no activity (lastNotificationAt is null or older than threshold)
            const staleSubscriptions = await this.pushSubscriptionRepository
                .createQueryBuilder('subscription')
                .where(
                    '(subscription.lastNotificationAt IS NULL AND subscription.createdAt < :cutoffDate) OR ' +
                    '(subscription.lastNotificationAt < :cutoffDate)',
                    { cutoffDate }
                )
                .getMany();

            if (staleSubscriptions.length === 0) {
                console.log(`[PushSubscriptionCleanup] No stale subscriptions found`);
                return;
            }

            // Group by type for logging
            const byType = staleSubscriptions.reduce((acc, sub) => {
                acc[sub.subscriptionType] = (acc[sub.subscriptionType] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);

            console.log(`[PushSubscriptionCleanup] Found ${staleSubscriptions.length} stale subscription(s): ${JSON.stringify(byType)}`);

            // Delete stale subscriptions
            const deleteResult = await this.pushSubscriptionRepository.remove(staleSubscriptions);

            console.log(`[PushSubscriptionCleanup] Cleanup completed: ${deleteResult.length} subscription(s) removed`);
        } catch (error: any) {
            console.error('[PushSubscriptionCleanup] Error during cleanup:', error.message);
        }
    }

    /**
     * Manually trigger cleanup (useful for testing)
     */
    public async cleanupNow(): Promise<{ deletedCount: number; details: Record<string, number> }> {
        try {
            console.log(`[PushSubscriptionCleanup] Manual cleanup triggered`);

            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - this.staleThresholdDays);

            const staleSubscriptions = await this.pushSubscriptionRepository
                .createQueryBuilder('subscription')
                .where(
                    '(subscription.lastNotificationAt IS NULL AND subscription.createdAt < :cutoffDate) OR ' +
                    '(subscription.lastNotificationAt < :cutoffDate)',
                    { cutoffDate }
                )
                .getMany();

            if (staleSubscriptions.length === 0) {
                return { deletedCount: 0, details: {} };
            }

            const byType = staleSubscriptions.reduce((acc, sub) => {
                acc[sub.subscriptionType] = (acc[sub.subscriptionType] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);

            await this.pushSubscriptionRepository.remove(staleSubscriptions);

            console.log(`[PushSubscriptionCleanup] Manual cleanup: ${staleSubscriptions.length} subscription(s) removed`);

            return { deletedCount: staleSubscriptions.length, details: byType };
        } catch (error: any) {
            console.error('[PushSubscriptionCleanup] Error during manual cleanup:', error.message);
            throw error;
        }
    }
}
