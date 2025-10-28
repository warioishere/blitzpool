import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

const onTextMock = jest.fn();
const onMock = jest.fn();
const setMyCommandsMock = jest.fn().mockResolvedValue(undefined);
const sendMessageMock = jest.fn();

const TelegramBotMock = jest.fn().mockImplementation(() => ({
    onText: onTextMock,
    on: onMock,
    setMyCommands: setMyCommandsMock,
    sendMessage: sendMessageMock,
}));

jest.mock('node-telegram-bot-api', () => TelegramBotMock);

describe('TelegramService device notifications without polling', () => {
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

    beforeEach(() => {
        jest.clearAllMocks();
        TelegramBotMock.mockClear();
        configServiceGetMock.mockImplementation((key: string) => {
            if (key === 'TELEGRAM_BOT_TOKEN') return 'token';
            if (key === 'TELEGRAM_TIMEZONE') return 'Europe/Berlin';
            if (key === 'TELEGRAM_DIFF_NOTIFICATIONS') return null;
            return null;
        });
        process.env.NODE_APP_INSTANCE = '1';
    });

    afterEach(() => {
        delete process.env.NODE_APP_INSTANCE;
    });

    it('instantiates the bot without polling and still delivers device notifications', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
        );

        expect(TelegramBotMock).toHaveBeenCalledWith('token', { polling: false });
        expect((service as any).shouldRegisterHandlers).toBe(false);

        await service.onModuleInit();
        expect(setMyCommandsMock).not.toHaveBeenCalled();

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
            '📶 Device with Antminer (worker Worker-1) back online at 1/1/24, 1:00 AM.',
        );
    });

    it('formats German device notifications using the configured timezone', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
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
});
