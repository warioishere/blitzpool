jest.mock('node-telegram-bot-api', () => jest.fn());

import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { NtfyService } from './ntfy.service';

jest.mock('axios', () => ({
    __esModule: true,
    default: {
        post: jest.fn().mockResolvedValue(undefined),
    },
}));

describe('NtfyService', () => {
    const configService = {
        get: jest.fn(),
    } as unknown as ConfigService;
    const configServiceGetMock = configService.get as jest.Mock;

    const telegramSubscriptionsService = {
        getAllAddresses: jest.fn(),
        getLanguage: jest.fn().mockResolvedValue('en'),
    };

    const clientService = {
        getAllAddresses: jest.fn(),
    };

    const addressSettingsService = {
        getSettings: jest.fn(),
        getBestDifficultiesForAddresses: jest.fn(async (_addrs: string[]) => new Map<string, number>()),
    };

    const clientStatisticsService = {};

    beforeEach(() => {
        jest.clearAllMocks();
        configServiceGetMock.mockImplementation(() => null);
        (axios.post as jest.Mock).mockClear();
        addressSettingsService.getSettings.mockReset();
    });

    it('resets cached best difficulty data without touching subscriptions', () => {
        const service = new NtfyService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            {} as any,
            {} as any,
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

    it('emits ntfy best diff notifications across instances after a reset', async () => {
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'NTFY_SERVER_URL') return 'https://ntfy.example';
            if (key === 'NTFY_DIFF_NOTIFICATIONS') return 'true';
            if (key === 'NTFY_ACCESS_TOKEN') return null;
            if (key === 'NTFY_TOPIC_PREFIX') return null;
            return null;
        });

        const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
        let persistedBest = 100;

        addressSettingsService.getSettings.mockImplementation(async () => ({
            bestDifficulty: persistedBest,
        }));

        const primaryService = new NtfyService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            {} as any,
            {} as any,
        );

        const secondaryService = new NtfyService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            {} as any,
            {} as any,
        );

        (primaryService as any).bestDiffCache.set(address, persistedBest);
        (secondaryService as any).bestDiffCache.set(address, persistedBest);
        (secondaryService as any).bestDiffOptIn.set(address, true);

        persistedBest = 0;
        primaryService.resetBestDiffCache(address);

        await secondaryService.notifySubscribersBestDiff(address, 80);

        expect(addressSettingsService.getSettings).toHaveBeenCalled();
        expect(axios.post).toHaveBeenCalledWith(
            'https://ntfy.example/' + address,
            expect.stringContaining('New best difficulty'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Content-Type': 'text/plain',
                    Tags: 'bot',
                }),
            })
        );
        expect((secondaryService as any).bestDiffCache.get(address)).toBe(80);
    });

    it('onModuleInit issues exactly one bulk read for bestDifficulty across all addresses', async () => {
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'NTFY_SERVER_URL') return 'https://ntfy.example';
            return null;
        });

        const addresses = ['addr-1', 'addr-2', 'addr-3'];
        clientService.getAllAddresses.mockResolvedValue(addresses);
        addressSettingsService.getBestDifficultiesForAddresses.mockResolvedValue(
            new Map([['addr-1', 100], ['addr-2', 200]]),
        );
        addressSettingsService.getSettings.mockResolvedValue({ bestDifficulty: 999 });

        const service = new NtfyService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            {} as any,
            {} as any,
        );
        // Stub reconnect() to avoid the SSE attempt.
        (service as any).reconnect = jest.fn();

        await service.onModuleInit();

        expect(addressSettingsService.getBestDifficultiesForAddresses).toHaveBeenCalledTimes(1);
        expect(addressSettingsService.getBestDifficultiesForAddresses).toHaveBeenCalledWith(addresses);
        // Old per-address getSettings path is no longer used in init.
        expect(addressSettingsService.getSettings).not.toHaveBeenCalled();
        // bestDiffCache populated from the bulk-fetch map (addr-3 → 0 default).
        expect((service as any).bestDiffCache.get('addr-1')).toBe(100);
        expect((service as any).bestDiffCache.get('addr-2')).toBe(200);
        expect((service as any).bestDiffCache.get('addr-3')).toBe(0);
    });
});
