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
    const configService = {
        get: jest.fn((key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? 'token' : null)),
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
            expect.stringContaining('back online'),
        );
    });
});
