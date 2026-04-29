import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

const onTextMock = jest.fn();
const onMock = jest.fn();
const setMyCommandsMock = jest.fn().mockResolvedValue(undefined);
const sendMessageMock = jest.fn();

jest.mock('node-telegram-bot-api', () => {
    return jest.fn().mockImplementation(() => ({
        onText: onTextMock,
        on: onMock,
        setMyCommands: setMyCommandsMock,
        sendMessage: sendMessageMock,
    }));
});

describe('TelegramService device notifications', () => {
    const configServiceGetMock = jest.fn();
    const configService = {
        get: configServiceGetMock,
    } as unknown as ConfigService;

    const telegramSubscriptionsService = {
        getAllAddresses: jest.fn().mockResolvedValue([]),
        getChatSubscriptions: jest.fn().mockResolvedValue([]),
        getSubscriptions: jest.fn().mockResolvedValue([
            { telegramChatId: 123, deviceNotificationsEnabled: true },
        ]),
    };

    const clientService = {};
    const addressSettingsService = {
        getSettings: jest.fn(),
    };
    const clientStatisticsService = {};
    const stratumV1Service = {};
    const ntfyService = {
        resetBestDiffCache: jest.fn(),
    };
    const pplnsService = {};
    const groupService = {};
    const groupSoloService = {};

    beforeEach(() => {
        jest.clearAllMocks();
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'TELEGRAM_BOT_TOKEN') return 'token';
            if (key === 'TELEGRAM_TIMEZONE') return 'Europe/Berlin';
            if (key === 'TELEGRAM_DIFF_NOTIFICATIONS') return null;
            return null;
        });
    });

    it('instantiates the bot and delivers device notifications', async () => {
        const TelegramBot = require('node-telegram-bot-api');
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            stratumV1Service as any,
            {} as any,
            ntfyService as any,
            pplnsService as any,
            groupService as any,
            groupSoloService as any,
        );

        expect(TelegramBot).toHaveBeenCalledWith('token', { polling: true });
        expect((service as any).shouldRegisterHandlers).toBe(true);

        await service.onModuleInit();

        (service as any).chatLanguages.set(123, 'en');

        await service.notifyDeviceStatusChange({
            address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
            workerName: 'Worker-1',
            userAgent: 'Antminer',
            sessionId: 'session-1',
            isOnline: true,
            timestamp: new Date('2024-01-01T00:00:00Z'),
        });

        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).toHaveBeenCalledWith(
            123,
            '📶 Device with Antminer (worker Worker-1) online at 1/1/24, 1:00 AM.',
        );
    });

    it('formats German device notifications using the configured timezone', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            stratumV1Service as any,
            {} as any,
            ntfyService as any,
            pplnsService as any,
            groupService as any,
            groupSoloService as any,
        );

        await service.onModuleInit();

        (service as any).chatLanguages.set(123, 'de');

        await service.notifyDeviceStatusChange({
            address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
            workerName: 'Worker-1',
            userAgent: 'Antminer',
            sessionId: 'session-1',
            isOnline: false,
            timestamp: new Date('2024-01-01T00:00:00Z'),
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            123,
            '📴 Gerät Antminer (Worker Worker-1) ist seit 01.01.24, 01:00 offline.',
        );
    });

    it('includes "back online" when isReturning is true', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            stratumV1Service as any,
            {} as any,
            ntfyService as any,
            pplnsService as any,
            groupService as any,
            groupSoloService as any,
        );

        await service.onModuleInit();

        (service as any).chatLanguages.set(123, 'en');

        await service.notifyDeviceStatusChange({
            address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
            workerName: 'Worker-1',
            userAgent: 'Antminer',
            sessionId: 'session-1',
            isOnline: true,
            timestamp: new Date('2024-01-01T00:00:00Z'),
            isReturning: true,
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            123,
            '📶 Device with Antminer (worker Worker-1) back online at 1/1/24, 1:00 AM.',
        );
    });

    it('includes "wieder" in German when isReturning is true', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            {} as any,
            stratumV1Service as any,
            {} as any,
            ntfyService as any,
            pplnsService as any,
            groupService as any,
            groupSoloService as any,
        );

        await service.onModuleInit();

        (service as any).chatLanguages.set(123, 'de');

        await service.notifyDeviceStatusChange({
            address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
            workerName: 'Worker-1',
            userAgent: 'Antminer',
            sessionId: 'session-1',
            isOnline: true,
            timestamp: new Date('2024-01-01T00:00:00Z'),
            isReturning: true,
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            123,
            '📶 Gerät Antminer (Worker Worker-1) ist seit 01.01.24, 01:00 wieder online.',
        );
    });
});
