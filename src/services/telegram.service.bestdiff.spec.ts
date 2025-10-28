import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

const onTextMock = jest.fn();
const onMock = jest.fn();
const setMyCommandsMock = jest.fn().mockResolvedValue(undefined);
const sendMessageMock = jest.fn().mockResolvedValue(undefined);

const TelegramBotMock = jest.fn().mockImplementation(() => ({
    onText: onTextMock,
    on: onMock,
    setMyCommands: setMyCommandsMock,
    sendMessage: sendMessageMock,
}));

jest.mock('node-telegram-bot-api', () => TelegramBotMock);

describe('TelegramService best diff commands', () => {
    const configServiceGetMock = jest.fn();
    const configService = {
        get: configServiceGetMock,
    } as unknown as ConfigService;

    const telegramSubscriptionsService = {
        getAllAddresses: jest.fn().mockResolvedValue([]),
        getDefault: jest.fn(),
        getChatSubscriptions: jest.fn(),
        updateBestDiffNotification: jest.fn(),
        updateDeviceNotifications: jest.fn(),
        getSubscriptions: jest.fn(),
        saveSubscription: jest.fn(),
        removeSubscription: jest.fn(),
    };

    const clientService = {};
    const addressSettingsService = {
        getSettings: jest.fn(),
        updateBestDifficulty: jest.fn(),
    };
    const clientStatisticsService = {};
    const stratumV1Service = {
        resetClientsForAddress: jest.fn(),
        resetBestDifficultyForAddress: jest.fn(),
    };
    const ntfyService = {
        resetBestDiffCache: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        TelegramBotMock.mockClear();
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'TELEGRAM_BOT_TOKEN') return 'token';
            if (key === 'TELEGRAM_TIMEZONE') return 'Europe/Berlin';
            if (key === 'TELEGRAM_DIFF_NOTIFICATIONS') return null;
            return null;
        });
        telegramSubscriptionsService.getDefault.mockReset();
        telegramSubscriptionsService.getChatSubscriptions.mockReset();
        telegramSubscriptionsService.getSubscriptions.mockReset();
        telegramSubscriptionsService.updateBestDiffNotification.mockReset().mockResolvedValue(undefined);
        addressSettingsService.getSettings.mockReset();
        addressSettingsService.updateBestDifficulty.mockReset().mockResolvedValue(undefined);
        stratumV1Service.resetClientsForAddress.mockReset();
        stratumV1Service.resetBestDifficultyForAddress.mockReset().mockResolvedValue(undefined);
        ntfyService.resetBestDiffCache.mockReset();
        sendMessageMock.mockClear();
        onTextMock.mockClear();
    });

    it('toggles best diff notifications on', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        await service.onModuleInit();

        const subscribeCall = onTextMock.mock.calls.find(
            ([regex]) => regex instanceof RegExp && regex.source.includes('\\/subscribe_bestdiff')
        );
        expect(subscribeCall).toBeDefined();
        const handler = subscribeCall?.[1] as (msg: any, match: RegExpExecArray | null) => Promise<void>;

        await handler(
            { chat: { id: 99 } },
            ['/subscribe_bestdiff on', 'on'] as unknown as RegExpExecArray
        );

        expect(telegramSubscriptionsService.updateBestDiffNotification).toHaveBeenCalledWith(99, true);
        expect(sendMessageMock).toHaveBeenCalledWith(
            99,
            'Best Difficulty Benachrichtigungen wurden aktiviert.'
        );
    });

    it('rejects missing action for best diff notifications', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        await service.onModuleInit();

        const subscribeCall = onTextMock.mock.calls.find(
            ([regex]) => regex instanceof RegExp && regex.source.includes('\\/subscribe_bestdiff')
        );
        const handler = subscribeCall?.[1] as (msg: any, match: RegExpExecArray | null) => Promise<void>;

        await handler(
            { chat: { id: 99 } },
            ['/subscribe_bestdiff'] as unknown as RegExpExecArray
        );

        expect(telegramSubscriptionsService.updateBestDiffNotification).not.toHaveBeenCalled();
        expect(sendMessageMock).toHaveBeenCalledWith(99, "Bitte gib 'on' oder 'off' an.");
    });

    it('resets best diff using the default address', async () => {
        telegramSubscriptionsService.getDefault.mockResolvedValue({ address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
        telegramSubscriptionsService.getChatSubscriptions.mockResolvedValue([
            { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', isDefault: true },
        ]);

        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        await service.onModuleInit();

        const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
        (service as any).bestDiffCache.set(address, 12345);

        const resetCall = onTextMock.mock.calls.find(
            ([regex]) => regex instanceof RegExp && regex.source.includes('\\/bestdiff_reset')
        );
        expect(resetCall).toBeDefined();
        const handler = resetCall?.[1] as (msg: any, match: RegExpExecArray | null) => Promise<void>;

        await handler(
            { chat: { id: 99 } },
            ['/bestdiff_reset'] as unknown as RegExpExecArray
        );

        expect(addressSettingsService.updateBestDifficulty).toHaveBeenCalledWith(address, 0, null);
        expect(ntfyService.resetBestDiffCache).toHaveBeenCalledWith(address);
        expect(stratumV1Service.resetBestDifficultyForAddress).toHaveBeenCalledWith(address);
        expect(stratumV1Service.resetClientsForAddress).not.toHaveBeenCalled();
        expect((service as any).bestDiffCache.has(address)).toBe(false);
        expect(sendMessageMock).toHaveBeenCalledWith(
            99,
            'Best Difficulty für 1Boa...TtpyT zurückgesetzt.'
        );
    });

    it('rejects best diff reset with invalid address parameter', async () => {
        telegramSubscriptionsService.getDefault.mockResolvedValue(null);
        telegramSubscriptionsService.getChatSubscriptions.mockResolvedValue([]);

        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        await service.onModuleInit();

        const resetCall = onTextMock.mock.calls.find(
            ([regex]) => regex instanceof RegExp && regex.source.includes('\\/bestdiff_reset')
        );
        const handler = resetCall?.[1] as (msg: any, match: RegExpExecArray | null) => Promise<void>;

        await handler(
            { chat: { id: 99 } },
            ['/bestdiff_reset invalid', 'invalid'] as unknown as RegExpExecArray
        );

        expect(addressSettingsService.updateBestDifficulty).not.toHaveBeenCalled();
        expect(stratumV1Service.resetBestDifficultyForAddress).not.toHaveBeenCalled();
        expect(stratumV1Service.resetClientsForAddress).not.toHaveBeenCalled();
        expect(sendMessageMock).toHaveBeenCalledWith(99, 'Ungültige Adresse.');
    });

    it('emits fresh best diff notifications across PM2 workers after a reset', async () => {
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'TELEGRAM_BOT_TOKEN') return 'token';
            if (key === 'TELEGRAM_TIMEZONE') return 'Europe/Berlin';
            if (key === 'TELEGRAM_DIFF_NOTIFICATIONS') return 'true';
            return null;
        });

        const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
        let persistedBest = 100;

        addressSettingsService.getSettings.mockImplementation(async () => ({
            bestDifficulty: persistedBest,
        }));

        telegramSubscriptionsService.getSubscriptions.mockResolvedValue([
            { telegramChatId: 7, bestDiffNotificationsEnabled: true },
        ]);

        telegramSubscriptionsService.getChatSubscriptions.mockResolvedValue([
            { address, isDefault: true },
        ]);

        const primaryService = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        const secondaryService = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        (primaryService as any).bestDiffCache.set(address, persistedBest);
        (secondaryService as any).bestDiffCache.set(address, persistedBest);

        persistedBest = 0;
        (primaryService as any).bestDiffCache.delete(address);

        sendMessageMock.mockClear();

        await secondaryService.notifySubscribersBestDiff(address, 80);

        expect(addressSettingsService.getSettings).toHaveBeenCalled();
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        const [chatId, text] = sendMessageMock.mock.calls[0] as [number, string];
        expect(chatId).toBe(7);
        expect(text).toContain('Neue beste Difficulty');
        expect(text).toContain('80');
        expect((secondaryService as any).bestDiffCache.get(address)).toBe(80);
    });
});
