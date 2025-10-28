import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';
import * as commonHandlers from './common-command-handlers';

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

describe('TelegramService /show_workers handler', () => {
    const configServiceGetMock = jest.fn();
    const configService = {
        get: configServiceGetMock,
    } as unknown as ConfigService;
    const telegramSubscriptionsService = {
        getAllAddresses: jest.fn().mockResolvedValue([]),
        getChatSubscriptions: jest.fn().mockResolvedValue([]),
        getDefault: jest.fn(),
        saveSubscription: jest.fn(),
        removeSubscription: jest.fn(),
        getSubscriptions: jest.fn(),
    };
    const clientService = {};
    const addressSettingsService = {
        getSettings: jest.fn().mockResolvedValue(null),
    };
    const clientStatisticsService = {};
    const stratumV1Service = {};
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
        (global as any).fetch = undefined;
    });

    it('fetches worker data and builds the overview message', async () => {
        const service = new TelegramService(
            configService,
            telegramSubscriptionsService as any,
            clientService as any,
            addressSettingsService as any,
            clientStatisticsService as any,
            stratumV1Service as any,
            ntfyService as any,
        );

        expect(TelegramBotMock).toHaveBeenCalledWith('token', { polling: true });
        expect((service as any).shouldRegisterHandlers).toBe(true);

        await service.onModuleInit();

        const showWorkersCall = onTextMock.mock.calls.find(
            ([regex]) => regex instanceof RegExp && regex.source.includes('\\/show_workers')
        );
        expect(showWorkersCall).toBeDefined();
        const handler = showWorkersCall?.[1] as (msg: any, match: RegExpExecArray | null) => Promise<void>;

        const apiData = {
            workersCount: 2,
            totalHashrate: 1500,
            totalShares: 50,
            bestDifficulty: 5000,
            workers: [
                { name: 'Alpha', hashRate: 1000, currentDifficulty: 2, bestDifficulty: '1000' },
                { name: 'Bravo', hashRate: 500, currentDifficulty: 4096, bestDifficulty: '2000' },
            ],
        };

        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(apiData),
        });
        (global as any).fetch = fetchMock;
        process.env.API_PORT = '5555';

        const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

        const helperSpy = jest
            .spyOn(commonHandlers, 'buildWorkersOverviewMessage')
            .mockReturnValue({ de: 'DE message', en: 'EN message' });

        await handler(
            { chat: { id: 42 }, text: `/show_workers ${address}` },
            [`/show_workers ${address}`, address] as unknown as RegExpExecArray
        );

        expect(fetchMock).toHaveBeenCalledWith(
            `http://localhost:5555/api/client/${encodeURIComponent(address)}`
        );
        expect(helperSpy).toHaveBeenCalledWith(apiData, (service as any).numberSuffix);
        expect(helperSpy.mock.calls[0][0].workers?.[1].currentDifficulty).toBe(4096);
        expect(sendMessageMock).toHaveBeenCalledWith(42, 'DE message');

        delete process.env.API_PORT;
        helperSpy.mockRestore();
    });
});
