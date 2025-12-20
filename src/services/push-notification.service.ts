import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as webpush from 'web-push';
import axios from 'axios';

import { PushSubscriptionService } from '../ORM/push-subscriptions/push-subscription.service';
import { BestDifficultyTrackerService } from '../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { FcmService } from './fcm.service';
import { PushSubscriptionType } from '../ORM/push-subscriptions/push-subscription-type.enum';

const CHECK_INTERVAL_SECONDS = 60; // 60 seconds

@Injectable()
export class PushNotificationService implements OnModuleInit {
    private isPrimaryInstance: boolean;
    private useVAPID: boolean;

    constructor(
        private readonly configService: ConfigService,
        private readonly pushSubscriptionService: PushSubscriptionService,
        private readonly trackerService: BestDifficultyTrackerService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly fcmService: FcmService,
    ) {
        // Only run on PM2 instance 0 (or when not in cluster mode)
        this.isPrimaryInstance = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

        // Initialize VAPID if keys are configured
        const vapidPublicKey = this.configService.get<string>('VAPID_PUBLIC_KEY');
        const vapidPrivateKey = this.configService.get<string>('VAPID_PRIVATE_KEY');
        const vapidSubject = this.configService.get<string>('VAPID_SUBJECT') || 'mailto:noreply@blitzpool.com';

        this.useVAPID = !!(vapidPublicKey && vapidPrivateKey);

        if (this.useVAPID) {
            webpush.setVapidDetails(vapidSubject, vapidPublicKey!, vapidPrivateKey!);
            console.log('[PushNotification] VAPID enabled for push notifications');
        } else {
            console.log('[PushNotification] VAPID disabled - using plain POST (ntfy compatible)');
        }
    }

    async onModuleInit(): Promise<void> {
        if (!this.isPrimaryInstance) {
            console.log('[PushNotification] Disabled on PM2 instance ' + process.env.NODE_APP_INSTANCE + ' (only runs on instance 0)');
            return;
        }

        console.log(`[PushNotification] Worker enabled on PM2 primary instance (0)`);
        console.log(`[PushNotification] Check interval: ${CHECK_INTERVAL_SECONDS} seconds`);
    }

    /**
     * Format difficulty number with suffix (T, G, M, K)
     */
    private formatDifficulty(num: number): string {
        if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'G';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toString();
    }

    /**
     * Send push notification using plain POST (ntfy-compatible)
     */
    private async sendPlainPost(endpoint: string, message: string): Promise<boolean> {
        try {
            const response = await axios.post(endpoint, message, {
                headers: {
                    'Content-Type': 'text/plain',
                },
                timeout: 10000, // 10 second timeout
            });

            if (response.status >= 200 && response.status < 300) {
                console.log(`[PushNotification] Plain POST sent to ${endpoint.substring(0, 50)}...`);
                return true;
            }
            return false;
        } catch (error: any) {
            console.error('[PushNotification] Plain POST error:', error.message);
            return false;
        }
    }

    /**
     * Send push notification to UnifiedPush endpoint
     * Supports both VAPID authentication and plain POST (fallback)
     */
    private async sendPushNotification(
        endpoint: string,
        title: string,
        body: string,
        difficulty: string
    ): Promise<boolean> {
        // Message format: "title|body|difficulty" (pipe-separated, ntfy compatible)
        const message = `${title}|${body}|${difficulty}`;

        // Try VAPID first if configured
        if (this.useVAPID) {
            try {
                await webpush.sendNotification(
                    { endpoint },
                    message,
                    {
                        TTL: 3600,
                        urgency: 'high',
                    }
                );
                console.log('[PushNotification] Sent via VAPID');
                return true;
            } catch (error: any) {
                console.warn('[PushNotification] VAPID failed, falling back to plain POST:', error.message);
                // Fall through to plain POST
            }
        }

        // Use plain POST (ntfy compatible) - either as primary or fallback
        return await this.sendPlainPost(endpoint, message);
    }

    /**
     * Send notifications for a specific address (dispatches to both Unified Push and FCM)
     */
    private async sendNotificationsForAddress(address: string, difficulty: number): Promise<void> {
        await this.sendUnifiedPushBestDiff(address, difficulty);
        await this.sendFcmBestDiff(address, difficulty);
    }

    /**
     * Send best difficulty notifications via Unified Push
     */
    private async sendUnifiedPushBestDiff(address: string, difficulty: number): Promise<void> {
        // Only notify subscriptions with best difficulty notifications enabled
        const subscriptions = await this.pushSubscriptionService.getUnifiedPushByAddressWithBestDiffNotifications(address);

        if (subscriptions.length === 0) {
            console.log(`[PushNotification] No Unified Push subscriptions with best diff enabled for ${address}`);
            return;
        }

        console.log(`[PushNotification] Sending Unified Push difficulty notification for ${address}: sending to ${subscriptions.length} endpoint(s)`);

        const title = 'New Best Difficulty!';
        const body = `Your best difficulty increased to ${this.formatDifficulty(difficulty)}`;
        const difficultyStr = this.formatDifficulty(difficulty);

        for (const subscription of subscriptions) {
            // Send push notification
            const success = await this.sendPushNotification(
                subscription.endpoint,
                title,
                body,
                difficultyStr
            );

            if (success) {
                await this.pushSubscriptionService.updateLastNotification(subscription.id, Date.now());
                console.log(`[PushNotification] Notification sent to ${subscription.platform} endpoint for ${address}`);
            } else {
                console.error(`[PushNotification] Failed to send notification to ${subscription.endpoint}`);
            }
        }
    }

    /**
     * Send best difficulty notifications via FCM
     */
    private async sendFcmBestDiff(address: string, difficulty: number): Promise<void> {
        const subscriptions = await this.pushSubscriptionService.getFcmByAddressWithBestDiffNotifications(address);

        if (subscriptions.length === 0) {
            console.log(`[PushNotification] No FCM subscriptions with best diff enabled for ${address}`);
            return;
        }

        console.log(`[PushNotification] Sending FCM difficulty notification for ${address}: sending to ${subscriptions.length} device(s)`);

        const title = 'New Best Difficulty!';
        const body = `Your best difficulty increased to ${this.formatDifficulty(difficulty)}`;
        const formattedDifficulty = this.formatDifficulty(difficulty);

        const notification = { title, body };
        const data = {
            type: 'best_difficulty',
            address: address,
            difficulty: difficulty.toString(),
            formattedDifficulty: formattedDifficulty,
            timestamp: Date.now().toString()
        };

        for (const subscription of subscriptions) {
            const result = await this.fcmService.sendNotification(
                subscription.endpoint,  // FCM token
                notification,
                data
            );

            if (result.success) {
                await this.pushSubscriptionService.updateLastNotification(
                    subscription.id,
                    Date.now()
                );
                console.log(`[PushNotification] FCM notification sent to ${subscription.platform} for ${address}`);
            } else if (result.invalidToken) {
                await this.pushSubscriptionService.deleteInvalidFcmToken(
                    address,
                    subscription.endpoint
                );
                console.log(`[PushNotification] Deleted invalid FCM token for ${address}`);
            } else {
                console.error(`[PushNotification] Failed to send FCM notification to ${subscription.endpoint}`);
            }
        }
    }

    /**
     * Check best difficulty for all subscribed addresses
     * Runs every 60 seconds
     */
    @Cron('*/60 * * * * *')
    async checkBestDifficulty(): Promise<void> {
        if (!this.isPrimaryInstance) {
            return;
        }

        try {
            const addresses = await this.pushSubscriptionService.getAddressesWithSubscriptions();

            if (addresses.length === 0) {
                return;
            }

            console.log(`[PushNotification] Checking best difficulty for ${addresses.length} address(es)`);

            for (const address of addresses) {
                try {
                    // Get current bestDifficulty from AddressSettingsService
                    const settings = await this.addressSettingsService.getSettings(address, false);
                    if (!settings) {
                        continue;
                    }

                    const currentDifficulty = settings.bestDifficulty ?? 0;

                    // Get tracker
                    const tracker = await this.trackerService.getTracker(address);

                    // Initialize tracker if it doesn't exist
                    if (!tracker) {
                        await this.trackerService.updateTracker(address, currentDifficulty);
                        console.log(`[PushNotification] Initialized tracker for ${address} with difficulty ${this.formatDifficulty(currentDifficulty)}`);
                        continue;
                    }

                    // Check if difficulty has increased
                    if (currentDifficulty > tracker.bestDifficulty) {
                        console.log(`[PushNotification] Difficulty increased for ${address}: ${this.formatDifficulty(tracker.bestDifficulty)} -> ${this.formatDifficulty(currentDifficulty)}`);

                        await this.sendNotificationsForAddress(address, currentDifficulty);
                        await this.trackerService.updateTracker(address, currentDifficulty);
                    } else if (currentDifficulty < tracker.bestDifficulty) {
                        console.log(`[PushNotification] WARNING: Difficulty decreased for ${address}: was ${this.formatDifficulty(tracker.bestDifficulty)}, now ${this.formatDifficulty(currentDifficulty)}`);
                    }
                } catch (error: any) {
                    console.error(`[PushNotification] Error checking address ${address}:`, error.message);
                }
            }
        } catch (error: any) {
            console.error('[PushNotification] Error in checkBestDifficulty:', error.message);
        }
    }

    /**
     * Notify subscribers when a device status changes (online/offline)
     * Called by NotificationService when a worker connects/disconnects
     */
    public async notifyDeviceStatusChange(params: {
        address: string;
        workerName?: string;
        userAgent?: string;
        sessionId: string;
        isOnline: boolean;
        timestamp: Date;
        isReturning?: boolean;
    }): Promise<void> {
        try {
            await this.sendUnifiedPushDeviceStatus(params);
            await this.sendFcmDeviceStatus(params);
        } catch (error: any) {
            console.error('[PushNotification] Error in notifyDeviceStatusChange:', error.message);
        }
    }

    /**
     * Send device status notification via Unified Push
     */
    private async sendUnifiedPushDeviceStatus(params: {
        address: string;
        workerName?: string;
        userAgent?: string;
        sessionId: string;
        isOnline: boolean;
        timestamp: Date;
        isReturning?: boolean;
    }): Promise<void> {
        const { address, workerName, userAgent, isOnline, timestamp, isReturning } = params;

        // Only notify subscriptions with device notifications enabled
        const subscriptions = await this.pushSubscriptionService.getUnifiedPushByAddressWithDeviceNotifications(address);

        if (subscriptions.length === 0) {
            return;
        }

        console.log(`[PushNotification] Device ${isOnline ? 'online' : 'offline'} (Unified Push) for ${address}, sending to ${subscriptions.length} endpoint(s)`);

        const worker = workerName || 'Unknown';
        const agent = userAgent || 'Unknown';
        const timeStr = timestamp.toLocaleString('en-US', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: 'UTC'
        });

        let title: string;
        if (isOnline) {
            title = isReturning ? 'Device Back Online' : 'Device Online';
        } else {
            title = 'Device Offline';
        }

        const body = `${agent} (${worker}) at ${timeStr}`;
        const notificationMessage = `${title}|${body}|`;

        for (const subscription of subscriptions) {
            try {
                const success = await this.sendPlainPost(subscription.endpoint, notificationMessage);

                if (success) {
                    console.log(`[PushNotification] Device status notification sent to ${subscription.platform} endpoint for ${address}`);
                } else {
                    console.error(`[PushNotification] Failed to send device status notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending device status notification:`, error.message);
            }
        }
    }

    /**
     * Send device status notification via FCM
     */
    private async sendFcmDeviceStatus(params: {
        address: string;
        workerName?: string;
        userAgent?: string;
        sessionId: string;
        isOnline: boolean;
        timestamp: Date;
        isReturning?: boolean;
    }): Promise<void> {
        const { address, workerName, userAgent, isOnline, timestamp, isReturning, sessionId } = params;

        const subscriptions = await this.pushSubscriptionService.getFcmByAddressWithDeviceNotifications(address);

        if (subscriptions.length === 0) {
            return;
        }

        console.log(`[PushNotification] Device ${isOnline ? 'online' : 'offline'} (FCM) for ${address}, sending to ${subscriptions.length} device(s)`);

        const worker = workerName || 'Unknown';
        const agent = userAgent || 'Unknown';
        const timeStr = timestamp.toLocaleString('en-US', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: 'UTC'
        });

        let title: string;
        if (isOnline) {
            title = isReturning ? 'Device Back Online' : 'Device Online';
        } else {
            title = 'Device Offline';
        }

        const body = `${agent} (${worker}) at ${timeStr}`;

        const notification = { title, body };
        const data = {
            type: 'device_status',
            address: address,
            status: isOnline ? 'online' : 'offline',
            isReturning: isReturning ? 'true' : 'false',
            workerName: worker,
            userAgent: agent,
            sessionId: sessionId,
            timestamp: timestamp.getTime().toString()
        };

        for (const subscription of subscriptions) {
            try {
                const result = await this.fcmService.sendNotification(
                    subscription.endpoint,
                    notification,
                    data
                );

                if (result.success) {
                    console.log(`[PushNotification] FCM device status notification sent to ${subscription.platform} for ${address}`);
                } else if (result.invalidToken) {
                    await this.pushSubscriptionService.deleteInvalidFcmToken(
                        address,
                        subscription.endpoint
                    );
                    console.log(`[PushNotification] Deleted invalid FCM token for ${address}`);
                } else {
                    console.error(`[PushNotification] Failed to send FCM device status notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending FCM device status notification:`, error.message);
            }
        }
    }

    /**
     * Notify subscribers when a block is found
     * Called by NotificationService when any address finds a block
     */
    public async notifySubscribersBlockFound(
        address: string,
        height: number,
        _block: any,
        message: string,
    ): Promise<void> {
        try {
            await this.sendUnifiedPushBlockFound(address, height, message);
            await this.sendFcmBlockFound(address, height, message);
        } catch (error: any) {
            console.error('[PushNotification] Error in notifySubscribersBlockFound:', error.message);
        }
    }

    /**
     * Send block found notification via Unified Push
     */
    private async sendUnifiedPushBlockFound(
        address: string,
        height: number,
        message: string
    ): Promise<void> {
        // Only notify subscriptions with block notifications enabled
        const subscriptions = await this.pushSubscriptionService.getUnifiedPushByAddressWithBlockNotifications(address);

        if (subscriptions.length === 0) {
            return;
        }

        console.log(`[PushNotification] Block found by ${address}! Sending (Unified Push) to ${subscriptions.length} endpoint(s)`);

        // Extract difficulty from message if present (e.g., "valid (158T)")
        const difficultyMatch = message.match(/\(([0-9.]+[KMGT]?)\)/);
        const difficulty = difficultyMatch ? difficultyMatch[1] : 'Unknown';

        const title = 'New Block Found!';
        const body = `Block height ${height}`;
        const notificationMessage = `${title}|${body}|${difficulty}`;

        for (const subscription of subscriptions) {
            try {
                const success = await this.sendPlainPost(subscription.endpoint, notificationMessage);

                if (success) {
                    console.log(`[PushNotification] Block notification sent to ${subscription.platform} endpoint for ${address}`);
                } else {
                    console.error(`[PushNotification] Failed to send block notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending block notification:`, error.message);
            }
        }
    }

    /**
     * Send block found notification via FCM
     */
    private async sendFcmBlockFound(
        address: string,
        height: number,
        message: string
    ): Promise<void> {
        const subscriptions = await this.pushSubscriptionService.getFcmByAddressWithBlockNotifications(address);

        if (subscriptions.length === 0) {
            return;
        }

        console.log(`[PushNotification] Block found by ${address}! Sending (FCM) to ${subscriptions.length} device(s)`);

        // Extract difficulty from message if present (e.g., "valid (158T)")
        const difficultyMatch = message.match(/\(([0-9.]+[KMGT]?)\)/);
        const difficulty = difficultyMatch ? difficultyMatch[1] : 'Unknown';

        const notification = {
            title: 'New Block Found!',
            body: `Block height ${height}`
        };

        const data = {
            type: 'block_found',
            address: address,
            height: height.toString(),
            difficulty: difficulty,
            timestamp: Date.now().toString()
        };

        for (const subscription of subscriptions) {
            try {
                const result = await this.fcmService.sendNotification(
                    subscription.endpoint,
                    notification,
                    data
                );

                if (result.success) {
                    console.log(`[PushNotification] FCM block notification sent to ${subscription.platform} for ${address}`);
                } else if (result.invalidToken) {
                    await this.pushSubscriptionService.deleteInvalidFcmToken(
                        address,
                        subscription.endpoint
                    );
                    console.log(`[PushNotification] Deleted invalid FCM token for ${address}`);
                } else {
                    console.error(`[PushNotification] Failed to send FCM block notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending FCM block notification:`, error.message);
            }
        }
    }
}
