import { Controller, Get, Post, Param, Body, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PushSubscriptionService } from '../../ORM/push-subscriptions/push-subscription.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { PushSubscriptionType } from '../../ORM/push-subscriptions/push-subscription-type.enum';
import { isoFromEpoch } from '../../utils/epoch-iso';

@Controller('push')
export class PushController {
    constructor(
        private readonly pushSubscriptionService: PushSubscriptionService,
        private readonly trackerService: BestDifficultyTrackerService,
        private readonly addressSettingsService: AddressSettingsService,
    ) {}

    /**
     * Validate that an address has mined on this pool before allowing registration
     * Security: Prevents spam and unauthorized monitoring of addresses
     */
    private async validateMinerAddress(address: string): Promise<void> {
        const settings = await this.addressSettingsService.getSettings(address, false);

        if (!settings) {
            throw new ForbiddenException(
                'Address has not mined on this pool. Only active miners can register for push notifications.'
            );
        }
    }

    /**
     * GET /api/push/info
     * Get information about push notification API for client integration
     */
    @Get('info')
    async getInfo() {
        return {
            success: true,
            version: '1.0.0',
            description: 'BlitzPool Push Notification API',
            notificationTypes: [
                {
                    type: 'best_difficulty',
                    description: 'When miner achieves new personal best difficulty',
                    frequency: 'Every 60 seconds if difficulty increased',
                    rateLimit: 'No rate limiting - immediate on difficulty increase'
                },
                {
                    type: 'device_status',
                    description: 'When mining device goes online or offline',
                    frequency: 'Real-time on connection/disconnection',
                    rateLimit: 'No rate limiting'
                },
                {
                    type: 'block_found',
                    description: 'When address finds a valid block',
                    frequency: 'Real-time when block is found',
                    rateLimit: 'No rate limiting'
                }
            ],
            methods: [
                {
                    method: 'POST',
                    path: '/api/push/register',
                    description: 'Register Unified Push endpoint (all notification types enabled by default). Requires address to have mined on this pool.',
                    body: {
                        address: 'bitcoin address (62 chars)',
                        endpoint: 'https://your-endpoint-url',
                        platform: 'optional identifier (default: unknown)'
                    }
                },
                {
                    method: 'POST',
                    path: '/api/push/fcm/register',
                    description: 'Register FCM device token (all notification types enabled by default). Requires address to have mined on this pool.',
                    body: {
                        address: 'bitcoin address (62 chars)',
                        token: 'FCM device token (100+ chars)',
                        platform: 'optional: android|ios|web'
                    }
                },
                {
                    method: 'POST',
                    path: '/api/push/unregister',
                    description: 'Remove Unified Push subscription',
                    body: {
                        address: 'bitcoin address',
                        endpoint: 'optional - specific endpoint to remove'
                    }
                },
                {
                    method: 'POST',
                    path: '/api/push/fcm/unregister',
                    description: 'Remove FCM token',
                    body: {
                        address: 'bitcoin address',
                        token: 'optional - specific FCM token to remove'
                    }
                },
                {
                    method: 'POST',
                    path: '/api/push/configure',
                    description: 'Update notification preferences',
                    body: {
                        address: 'bitcoin address',
                        endpoint: 'Unified Push URL or FCM token',
                        bestDiffNotifications: 'optional boolean',
                        deviceNotifications: 'optional boolean',
                        blockNotifications: 'optional boolean'
                    }
                },
                {
                    method: 'GET',
                    path: '/api/push/status/:address',
                    description: 'Check subscription status and preferences',
                    response: 'Subscription details and notification preferences'
                }
            ],
            unifiedPush: {
                description: 'Privacy-focused decentralized push notifications',
                setup: 'Choose a Unified Push distributor (e.g., ntfy.sh, self-hosted)',
                exampleEndpoints: [
                    'https://ntfy.sh/my-mining-alerts',
                    'https://push.example.com/up/abc123'
                ],
                documentation: 'https://unifiedpush.org/'
            },
            fcm: {
                description: 'Firebase Cloud Messaging for native mobile apps',
                setup: 'Get FCM token from your mobile app using Firebase SDK',
                tokenFormat: {
                    length: '100+ characters',
                    characters: 'any valid FCM token format'
                },
                documentation: 'https://firebase.google.com/docs/cloud-messaging'
            },
            examples: {
                registerUnifiedPush: {
                    method: 'POST /api/push/register',
                    body: {
                        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
                        endpoint: 'https://ntfy.sh/my-blitzpool-alerts',
                        platform: 'ntfy'
                    }
                },
                registerFcm: {
                    method: 'POST /api/push/fcm/register',
                    body: {
                        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
                        token: 'eRx9R8tUVzBBNIH9_8HYKjd7fKQRx4XO3IvlB6HK2Ko:APA91bHLl_8-0j8I3xEqR4j9xVl_yD7Wjb4K5Z6Y1Xl0PqN',
                        platform: 'android'
                    }
                },
                enableNotifications: {
                    method: 'POST /api/push/configure',
                    body: {
                        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
                        endpoint: 'https://ntfy.sh/my-blitzpool-alerts',
                        bestDiffNotifications: true,
                        deviceNotifications: true,
                        blockNotifications: true
                    }
                }
            },
            rateLimits: {
                bestDiffNotifications: 'No rate limiting - immediate on difficulty increase',
                deviceNotifications: 'No rate limiting - immediate on event',
                blockNotifications: 'No rate limiting - immediate on event'
            },
            documentation: '/docs/PUSH_NOTIFICATIONS.md'
        };
    }

    /**
     * POST /api/push/register
     * Register a new push subscription
     */
    @Post('register')
    async register(@Body() body: { address: string; endpoint: string; platform?: string }) {
        const { address, endpoint, platform = 'unknown' } = body;

        if (!address || !endpoint) {
            throw new BadRequestException('Missing required fields: address, endpoint');
        }

        // Security: Validate that address has mined on this pool
        await this.validateMinerAddress(address);

        try {
            const subscription = await this.pushSubscriptionService.createOrUpdate(
                address,
                endpoint,
                platform
            );

            console.log(`[PushController] Push subscription registered: ${address} -> ${endpoint}`);

            return {
                success: true,
                subscription: {
                    id: subscription.id,
                    address: subscription.address,
                    platform: subscription.platform,
                    createdAt: isoFromEpoch(subscription.createdAt),
                }
            };
        } catch (error: any) {
            console.error('[PushController] Error registering push subscription:', error);
            throw new BadRequestException('Failed to register push subscription');
        }
    }

    /**
     * POST /api/push/unregister
     * Unregister from push notifications
     */
    @Post('unregister')
    async unregister(@Body() body: { address: string; endpoint?: string }) {
        const { address, endpoint } = body;

        if (!address) {
            throw new BadRequestException('Missing required field: address');
        }

        try {
            if (endpoint) {
                await this.pushSubscriptionService.delete(address, endpoint);
                console.log(`[PushController] Push subscription unregistered: ${address} -> ${endpoint}`);
            } else {
                await this.pushSubscriptionService.deleteByAddress(address);
                console.log(`[PushController] All push subscriptions unregistered for: ${address}`);
            }

            return { success: true };
        } catch (error: any) {
            console.error('[PushController] Error unregistering push subscription:', error);
            throw new BadRequestException('Failed to unregister push subscription');
        }
    }

    /**
     * GET /api/push/status/:address
     * Get subscription status for an address
     */
    @Get('status/:address')
    async getStatus(@Param('address') address: string) {
        try {
            const subscriptions = await this.pushSubscriptionService.getByAddress(address);
            const tracker = await this.trackerService.getTracker(address);

            return {
                address,
                subscriptionCount: subscriptions.length,
                subscriptions: subscriptions.map(s => ({
                    id: s.id,
                    platform: s.platform,
                    endpoint: s.endpoint,
                    subscriptionType: s.subscriptionType,
                    createdAt: isoFromEpoch(s.createdAt),
                    lastNotificationAt: isoFromEpoch(s.lastNotificationAt),
                    bestDiffNotificationsEnabled: s.bestDiffNotificationsEnabled,
                    deviceNotificationsEnabled: s.deviceNotificationsEnabled,
                    blockNotificationsEnabled: s.blockNotificationsEnabled
                })),
                tracker: tracker ? {
                    bestDifficulty: tracker.bestDifficulty,
                    lastCheckedAt: isoFromEpoch(tracker.lastCheckedAt),
                } : null
            };
        } catch (error: any) {
            console.error('[PushController] Error getting push status:', error);
            throw new BadRequestException('Failed to get push status');
        }
    }

    /**
     * POST /api/push/configure
     * Configure notification preferences for a subscription
     */
    @Post('configure')
    async configure(@Body() body: {
        address: string;
        endpoint: string;
        bestDiffNotifications?: boolean;
        deviceNotifications?: boolean;
        blockNotifications?: boolean;
        networkDiffNotifications?: boolean;
    }) {
        const { address, endpoint, bestDiffNotifications, deviceNotifications, blockNotifications, networkDiffNotifications } = body;

        if (!address || !endpoint) {
            throw new BadRequestException('Missing required fields: address, endpoint');
        }

        try {
            await this.pushSubscriptionService.updateNotificationPreferences(
                address,
                endpoint,
                bestDiffNotifications,
                deviceNotifications,
                blockNotifications,
                networkDiffNotifications
            );

            console.log(`[PushController] Updated notification preferences for ${address} -> ${endpoint}`);

            return { success: true };
        } catch (error: any) {
            console.error('[PushController] Error configuring push notifications:', error);
            throw new BadRequestException('Failed to configure push notifications');
        }
    }

    /**
     * POST /api/push/fcm/register
     * Register FCM token for push notifications
     */
    @Post('fcm/register')
    async registerFcm(@Body() body: { address: string; token: string; platform?: string }) {
        const { address, token, platform = 'fcm' } = body;

        if (!address || !token) {
            throw new BadRequestException('Missing required fields: address, token');
        }

        // Security: Validate that address has mined on this pool
        await this.validateMinerAddress(address);

        try {
            // Validate FCM token format (100+ chars)
            if (!token || token.length < 100) {
                throw new BadRequestException('Invalid FCM token format');
            }

            const subscription = await this.pushSubscriptionService.createOrUpdate(
                address,
                token,
                platform,
                PushSubscriptionType.FCM
            );

            console.log(`[PushController] FCM token registered: ${address} -> ${token.substring(0, 20)}...`);

            return {
                success: true,
                subscriptionType: 'fcm',
                subscription: {
                    id: subscription.id,
                    address: subscription.address,
                    platform: subscription.platform,
                    createdAt: isoFromEpoch(subscription.createdAt),
                }
            };
        } catch (error: any) {
            console.error('[PushController] Error registering FCM token:', error);
            throw new BadRequestException('Failed to register FCM token');
        }
    }

    /**
     * POST /api/push/fcm/unregister
     * Unregister FCM token
     */
    @Post('fcm/unregister')
    async unregisterFcm(@Body() body: { address: string; token?: string }) {
        const { address, token } = body;

        if (!address) {
            throw new BadRequestException('Missing required field: address');
        }

        try {
            if (token) {
                await this.pushSubscriptionService.delete(
                    address,
                    token,
                    PushSubscriptionType.FCM
                );
                console.log(`[PushController] FCM token unregistered: ${address} -> ${token.substring(0, 20)}...`);
            } else {
                // Delete all FCM subscriptions for address
                await this.pushSubscriptionService.deleteAllByType(
                    address,
                    PushSubscriptionType.FCM
                );
                console.log(`[PushController] All FCM tokens unregistered for: ${address}`);
            }

            return { success: true };
        } catch (error: any) {
            console.error('[PushController] Error unregistering FCM token:', error);
            throw new BadRequestException('Failed to unregister FCM token');
        }
    }
}
