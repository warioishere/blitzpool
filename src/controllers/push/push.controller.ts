import { Controller, Get, Post, Param, Body, BadRequestException } from '@nestjs/common';
import { PushSubscriptionService } from '../../ORM/push-subscriptions/push-subscription.service';
import { BestDifficultyTrackerService } from '../../ORM/best-difficulty-tracker/best-difficulty-tracker.service';

@Controller('push')
export class PushController {
    constructor(
        private readonly pushSubscriptionService: PushSubscriptionService,
        private readonly trackerService: BestDifficultyTrackerService,
    ) {}

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
                    createdAt: subscription.createdAt
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
                    createdAt: s.createdAt,
                    lastNotificationAt: s.lastNotificationAt
                })),
                tracker: tracker ? {
                    bestDifficulty: tracker.bestDifficulty,
                    lastCheckedAt: tracker.lastCheckedAt
                } : null
            };
        } catch (error: any) {
            console.error('[PushController] Error getting push status:', error);
            throw new BadRequestException('Failed to get push status');
        }
    }
}
