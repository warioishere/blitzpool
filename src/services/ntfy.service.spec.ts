import { ConfigService } from '@nestjs/config';
import { NtfyService } from './ntfy.service';

describe('NtfyService', () => {
    const configService = {
        get: jest.fn(),
    } as unknown as ConfigService;

    const telegramSubscriptionsService = {
        getAllAddresses: jest.fn(),
    };

    const clientService = {
        getAllAddresses: jest.fn(),
    };

    const addressSettingsService = {
        getSettings: jest.fn(),
    };

    const clientStatisticsService = {};

    beforeEach(() => {
        jest.clearAllMocks();
        (configService.get as jest.Mock).mockImplementation(() => null);
    });

    it('resets cached best difficulty data without touching subscriptions', () => {
        const service = new NtfyService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
        );

        const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

        (service as any).bestDiffCache.set(address, 42);
        (service as any).bestDiffOptIn.set(address, true);
        (service as any).subscribed.add(address);

        service.resetBestDiffCache(address);

        expect((service as any).bestDiffCache.has(address)).toBe(false);
        expect((service as any).bestDiffOptIn.has(address)).toBe(false);
        expect((service as any).subscribed.has(address)).toBe(true);
    });
});
