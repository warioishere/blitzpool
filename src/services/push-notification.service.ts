import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as webpush from 'web-push';
import axios from 'axios';

import { PushSubscriptionService } from '../ORM/push-subscriptions/push-subscription.service';
import { BestDifficultyTrackerService } from '../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { NetworkDifficultyTrackerService } from '../ORM/network-difficulty-tracker/network-difficulty-tracker.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { FcmService } from './fcm.service';
import { PushSubscriptionType } from '../ORM/push-subscriptions/push-subscription-type.enum';

const CHECK_INTERVAL_SECONDS = 60; // 60 seconds

@Injectable()
export class PushNotificationService implements OnModuleInit {
    private useVAPID: boolean;

    constructor(
        private readonly configService: ConfigService,
        private readonly pushSubscriptionService: PushSubscriptionService,
        private readonly trackerService: BestDifficultyTrackerService,
        private readonly networkDiffTrackerService: NetworkDifficultyTrackerService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly fcmService: FcmService,
    ) {
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
        console.log(`[PushNotification] Worker enabled`);
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
     *
     * Skips both DB roundtrips when the in-memory presence cache says the
     * address has no subscription at all — the common case for the vast
     * majority of mining addresses. Falls through to the DB path while the
     * cache is bootstrapping (correct, just unoptimised).
     */
    private async sendNotificationsForAddress(address: string, difficulty: number): Promise<void> {
        if (!this.pushSubscriptionService.hasAnySubscription(address)) {
            return;
        }
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
     * Check best difficulty for all subscribed addresses.
     * Runs every 60 seconds at sec=43 — offset away from `:x0:00`
     * slot boundaries so the per-address PG fan-out doesn't pile
     * onto the cron-storm that aggregation jobs used to create
     * there.
     */
    @Cron('43 * * * * *')
    async checkBestDifficulty(): Promise<void> {

        try {
            // Prefer the in-memory cache (zero DB roundtrip); if it isn't
            // ready yet, fall back to the original DISTINCT query.
            const addresses = this.pushSubscriptionService.getCachedAddressesWithSubscriptions()
                ?? await this.pushSubscriptionService.getAddressesWithSubscriptions();

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
                        // address_settings is the source of truth. A drop is
                        // expected after /bestdiff_reset (settings -> 0 before
                        // resetTracker lands) and for legacy rows that lost
                        // precision under the old `real` column. Sync the
                        // tracker down silently — the previous WARNING log
                        // was a leftover from the pre-migration drift bug
                        // (1776000000000-AddressSettingsBestDifficultyToDouble).
                        await this.trackerService.updateTracker(address, currentDifficulty);
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
        // Stratum connect/disconnect fires this on every session for every
        // address — but only a handful of addresses ever subscribe to push.
        // The presence cache lets us skip the per-type DB roundtrips for
        // addresses that have no subscription at all (i.e. the vast
        // majority of mining addresses). Falls through transparently
        // whenever the cache is not ready.
        if (!this.pushSubscriptionService.hasAnySubscription(params.address)) {
            return;
        }
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
        if (!this.pushSubscriptionService.hasAnySubscription(address)) {
            return;
        }
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

    /**
     * Fetch current network difficulty from mempool.space API
     */
    private async fetchNetworkDifficulty(): Promise<number | null> {
        try {
            const response = await axios.get('https://mempool.space/api/v1/mining/hashrate/3d', {
                timeout: 10000
            });

            if (response.data && response.data.currentDifficulty) {
                return response.data.currentDifficulty;
            }

            console.error('[PushNotification] Failed to get currentDifficulty from API response');
            return null;
        } catch (error: any) {
            console.error('[PushNotification] Error fetching network difficulty:', error.message);
            return null;
        }
    }

    /**
     * Calculate percentage change between two values
     */
    private calculatePercentageChange(oldValue: number, newValue: number): number {
        return ((newValue - oldValue) / oldValue) * 100;
    }

    /**
     * Check network difficulty for changes (every 10 minutes).
     * Bitcoin difficulty adjusts approximately every 2016 blocks (~14 days).
     * Sec-offset 7 keeps this off the slot boundary.
     */
    @Cron('7 */10 * * * *')
    async checkNetworkDifficulty(): Promise<void> {

        try {
            const currentDifficulty = await this.fetchNetworkDifficulty();

            if (!currentDifficulty) {
                console.error('[PushNotification] Failed to fetch network difficulty');
                return;
            }

            const tracker = await this.networkDiffTrackerService.getTracker();

            if (!tracker) {
                // First time - initialize tracker
                await this.networkDiffTrackerService.updateTracker(currentDifficulty, false);
                console.log(`[PushNotification] Initialized network difficulty tracker: ${this.formatDifficulty(currentDifficulty)}`);
                return;
            }

            // Check if difficulty has changed (allow small floating point variance)
            const diffThreshold = 0.0001; // 0.01% threshold to avoid floating point issues
            const diffChange = Math.abs(currentDifficulty - tracker.currentDifficulty);
            const diffChangePercent = (diffChange / tracker.currentDifficulty) * 100;

            if (diffChangePercent > diffThreshold) {
                // Difficulty has changed!
                const percentChange = this.calculatePercentageChange(tracker.currentDifficulty, currentDifficulty);
                const changeDirection = percentChange > 0 ? 'increased' : 'decreased';

                console.log(`[PushNotification] Network difficulty ${changeDirection}! ${this.formatDifficulty(tracker.currentDifficulty)} -> ${this.formatDifficulty(currentDifficulty)} (${percentChange > 0 ? '+' : ''}${percentChange.toFixed(2)}%)`);

                // Send notifications to all subscribed users
                await this.sendNetworkDifficultyNotifications(
                    tracker.currentDifficulty,
                    currentDifficulty,
                    percentChange
                );

                // Update tracker
                await this.networkDiffTrackerService.updateTracker(currentDifficulty, true);
            } else {
                // No change, just update last checked timestamp
                await this.networkDiffTrackerService.updateTracker(currentDifficulty, false);
            }
        } catch (error: any) {
            console.error('[PushNotification] Error in checkNetworkDifficulty:', error.message);
        }
    }

    /**
     * Send network difficulty change notifications (dispatches to both Unified Push and FCM)
     */
    private async sendNetworkDifficultyNotifications(
        oldDifficulty: number,
        newDifficulty: number,
        percentChange: number
    ): Promise<void> {
        await this.sendUnifiedPushNetworkDiff(oldDifficulty, newDifficulty, percentChange);
        await this.sendFcmNetworkDiff(oldDifficulty, newDifficulty, percentChange);
    }

    /**
     * Send network difficulty change notification via Unified Push
     */
    private async sendUnifiedPushNetworkDiff(
        oldDifficulty: number,
        newDifficulty: number,
        percentChange: number
    ): Promise<void> {
        const subscriptions = await this.pushSubscriptionService.getUnifiedPushWithNetworkDiffNotifications();

        if (subscriptions.length === 0) {
            console.log('[PushNotification] No Unified Push subscriptions with network diff enabled');
            return;
        }

        console.log(`[PushNotification] Sending Unified Push network difficulty notification to ${subscriptions.length} endpoint(s)`);

        const changeDirection = percentChange > 0 ? 'Increased' : 'Decreased';
        const title = `Network Difficulty ${changeDirection}`;
        const body = `Changed from ${this.formatDifficulty(oldDifficulty)} to ${this.formatDifficulty(newDifficulty)} (${percentChange > 0 ? '+' : ''}${percentChange.toFixed(2)}%)`;
        const notificationMessage = `${title}|${body}|`;

        for (const subscription of subscriptions) {
            try {
                const success = await this.sendPlainPost(subscription.endpoint, notificationMessage);

                if (success) {
                    console.log(`[PushNotification] Network diff notification sent to ${subscription.platform} endpoint for ${subscription.address}`);
                } else {
                    console.error(`[PushNotification] Failed to send network diff notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending network diff notification:`, error.message);
            }
        }
    }

    /**
     * Send network difficulty change notification via FCM
     */
    private async sendFcmNetworkDiff(
        oldDifficulty: number,
        newDifficulty: number,
        percentChange: number
    ): Promise<void> {
        const subscriptions = await this.pushSubscriptionService.getFcmWithNetworkDiffNotifications();

        if (subscriptions.length === 0) {
            console.log('[PushNotification] No FCM subscriptions with network diff enabled');
            return;
        }

        console.log(`[PushNotification] Sending FCM network difficulty notification to ${subscriptions.length} device(s)`);

        const changeDirection = percentChange > 0 ? 'Increased' : 'Decreased';
        const notification = {
            title: `Network Difficulty ${changeDirection}`,
            body: `Changed from ${this.formatDifficulty(oldDifficulty)} to ${this.formatDifficulty(newDifficulty)} (${percentChange > 0 ? '+' : ''}${percentChange.toFixed(2)}%)`
        };

        const data = {
            type: 'network_difficulty',
            oldDifficulty: oldDifficulty.toString(),
            newDifficulty: newDifficulty.toString(),
            percentChange: percentChange.toString(),
            formattedOldDifficulty: this.formatDifficulty(oldDifficulty),
            formattedNewDifficulty: this.formatDifficulty(newDifficulty),
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
                    console.log(`[PushNotification] FCM network diff notification sent to ${subscription.platform} for ${subscription.address}`);
                } else if (result.invalidToken) {
                    await this.pushSubscriptionService.deleteInvalidFcmToken(
                        subscription.address,
                        subscription.endpoint
                    );
                    console.log(`[PushNotification] Deleted invalid FCM token for ${subscription.address}`);
                } else {
                    console.error(`[PushNotification] Failed to send FCM network diff notification to ${subscription.endpoint}`);
                }
            } catch (error: any) {
                console.error(`[PushNotification] Error sending FCM network diff notification:`, error.message);
            }
        }
    }
}
