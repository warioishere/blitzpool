import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';
import { NumberSuffix } from '../utils/NumberSuffix';
import { decryptMessageIfNeeded } from '../utils/message-decryptor';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { ClientStatsAggregator } from './client-stats-aggregator.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';

@Injectable()
export class TelegramService implements OnModuleInit {
    private bot: TelegramBot;
    private diffNotifications: boolean;
    private numberSuffix: NumberSuffix;
    private bestDiffCache: Map<string, number> = new Map();
    private chatLang: Map<number, 'de' | 'en'> = new Map();

    private t(chatId: number, de: string, en: string): string {
        return (this.chatLang.get(chatId) ?? 'de') === 'en' ? en : de;
    }

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly clientStatsAggregator: ClientStatsAggregator,
        private readonly clientStatisticsService: ClientStatisticsService,
    ) {
        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');

        if (!token || token.length < 1) {
            return;
        }

        this.bot = new TelegramBot(token, { polling: true });

        console.log('Telegram bot init');

        this.numberSuffix = new NumberSuffix();
        this.diffNotifications = (this.configService.get('TELEGRAM_DIFF_NOTIFICATIONS')?.toLowerCase() === 'true') || false;
    }

    async onModuleInit(): Promise<void> {
        if (!this.bot) return;

        // Telegram Menübefehle registrieren
        await this.bot.setMyCommands([
            { command: '/start', description: 'Zeigt Willkommensnachricht' },
            { command: '/english', description: 'Switch bot language to English' },
            { command: '/deutsch', description: 'Bot Sprache auf Deutsch' },
            { command: '/subscribe', description: 'Benachrichtigung bei Blockhit aktivieren' },
            { command: '/subscribe_bestdiff', description: 'Best-Diff Benachrichtigungen (on/off, Standard: on)' },
            { command: '/difficulty', description: 'Zeigt aktuelle Netzwerk-Difficulty' },
            { command: '/next_difficulty', description: 'Zeigt erwartete Änderung der Netzwerk-Difficulty' },
            { command: '/stats', description: 'Zeigt die Stats für deine Miner Adresse an' },
            { command: '/poolhashrate', description: 'Zeigt die aktuelle Pool-Hashrate' }
        ]);

        this.bot.onText(/\/english/, msg => {
            this.chatLang.set(msg.chat.id, 'en');
            this.bot.sendMessage(msg.chat.id, 'Language switched to English.');
        });

        this.bot.onText(/\/deutsch/, msg => {
            this.chatLang.set(msg.chat.id, 'de');
            this.bot.sendMessage(msg.chat.id, 'Sprache auf Deutsch umgestellt.');
        });

        this.bot.onText(/\/subscribe (.+)/, async (msg, match) => {
            const raw = match?.[1]?.trim();
            if (!raw) {
                this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Befehl nicht erkannt, oder Wert fehlt', 'Command not recognized, or value missing'));
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt:", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Ungültige Adresse.', 'Invalid address.'));
                return;
            }

            const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
            if (subscribers.length === 0) {
                await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
                this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Benachrichtigung aktiviert!', 'Notification enabled!'));
            } else {
                this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Bereits registriert!', 'Already registered!'));
            }
        });

        this.bot.onText(/\/subscribe_bestdiff (on|off)/i, async (msg, match) => {
            const chatId = msg.chat.id;
            const value = match?.[1]?.toLowerCase();

            if (!value) {
                this.bot.sendMessage(chatId, this.t(chatId, 'Befehl nicht erkannt, oder Wert fehlt', 'Command not recognized, or value missing'));
                return;
            }

            const enable = value === 'on';

            try {
                await this.telegramSubscriptionsService.updateBestDiffNotification(chatId, enable);
                this.bot.sendMessage(chatId, this.t(chatId, `Best Difficulty Benachrichtigungen wurden ${enable ? 'aktiviert' : 'deaktiviert'}.`, `Best difficulty notifications ${enable ? 'enabled' : 'disabled'}.`));
            } catch (error) {
                console.error("Fehler bei /subscribe_bestdiff:", error);
                this.bot.sendMessage(chatId, this.t(chatId, 'Fehler beim Setzen der Einstellung. Bitte später erneut versuchen.', 'Error saving setting. Please try again later.'));
            }
        });

        this.bot.onText(/\/start/, (msg) => {
            const de = `Willkommen beim BlitzPool Status Bot! 💡\n\n` +
                `Nutze /english oder /deutsch, um die Sprache zu wechseln.\n\n` +
                `Du kannst mir:\n` +
                `– direkt schreiben (z. B. /subscribe BitcoinAdresse)\n` +
                `– oder verschlüsselt senden (z. B. über das Verschlüsselungstool)\n\n` +
                `🔐 Du kannst mir die BTC Worker Adresse auch verschlüsselt senden:\n` +
                `1. Lesst euch die README durch: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/blob/master/README.md\n` +
                `2a. Ladet den Python-Script für Linux und Mac herunter: https://cloud.yourdevice.ch/s/TbqdwE24jTRmtRp\n` +
                `2b. Oder für Windows: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/releases/tag/v1.0.0\n` +
                `3a. Führt den Script im Terminal aus mit './encrypt-message.py'\n` +
                `3b. Oder auf Windows mit Doppelklick auf die .exe\n` +
                `4. Gebt eure BTC-Adresse ein.\n` +
                `5. Sende '/subscribe <verschlüsselte Adresse>' direkt an mich.\n` +
                `6. Sende '/stats <verschlüsselte Adresse>' für deine Statistiken.\n\n` +
                `Ich entschlüssle ihn und reagiere genau wie bei Klartext. 🔒`;

            const en = `Welcome to the BlitzPool status bot! 💡\n\n` +
                `Use /english or /deutsch to switch the language.\n\n` +
                `You can:\n` +
                `– message me directly (e.g. /subscribe BitcoinAddress)\n` +
                `– or send it encrypted using the encryption tool\n\n` +
                `🔐 You may also send the BTC worker address encrypted:\n` +
                `1. Read the README: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/blob/master/README.md\n` +
                `2a. Download the Python script for Linux and Mac: https://cloud.yourdevice.ch/s/TbqdwE24jTRmtRp\n` +
                `2b. Or for Windows: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/releases/tag/v1.0.0\n` +
                `3a. Run the script with './encrypt-message.py'\n` +
                `3b. Or double-click the .exe on Windows\n` +
                `4. Enter your BTC address.\n` +
                `5. Send '/subscribe <encrypted address>' to me.\n` +
                `6. Send '/stats <encrypted address>' for your stats.\n\n` +
                `I will decrypt it and process it like a normal message. 🔒`;

            this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, de, en));
        });

        this.bot.onText(/\/difficulty/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const res = await fetch('https://mempool.space/api/v1/mining/hashrate/3d');
                const json = await res.json();
                const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
                this.bot.sendMessage(chatId, this.t(chatId, `Aktuelle Difficulty: ${difficulty} T`, `Current difficulty: ${difficulty} T`));
            } catch (e) {
                this.bot.sendMessage(chatId, this.t(chatId, 'Konnte die Difficulty nicht abrufen.', 'Could not fetch difficulty.'));
                console.error(e);
            }
        });

        this.bot.onText(/\/next_difficulty/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const res = await fetch('https://mempool.space/api/v1/difficulty-adjustment');
                const data = await res.json();

                const progress = data.progressPercent.toFixed(2);
                const change = data.difficultyChange.toFixed(2);
                const estimatedDate = new Date(data.estimatedRetargetDate).toLocaleString('de-CH');

                const changeText = change >= 0 ? `📈 +${change}%` : `📉 ${change}%`;

                const deText = `📊 Nächste Difficulty-Anpassung:\n\n• Fortschritt: ${progress}%\n• Geschätzt: ${estimatedDate}\n• Erwartete Änderung: ${changeText}`;
                const enText = `📊 Next difficulty adjustment:\n\n• Progress: ${progress}%\n• Estimated: ${estimatedDate}\n• Expected change: ${changeText}`;
                this.bot.sendMessage(chatId, this.t(chatId, deText, enText));
            } catch (err) {
                console.error("Fehler bei /next_difficulty:", err);
                this.bot.sendMessage(chatId, this.t(chatId, 'Konnte die nächste Difficulty-Anpassung nicht abrufen.', 'Could not fetch next difficulty adjustment.'));
            }
        });

        this.bot.onText(/\/poolhashrate/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const apiPort = process.env.API_PORT || '3334';
                const res = await fetch(`http://localhost:${apiPort}/api/pool`);
                const data = await res.json();
                const hashrateTH = (data.totalHashRate / 1e12).toFixed(2);
                this.bot.sendMessage(chatId, this.t(chatId, `Aktuelle Pool-Hashrate: ${hashrateTH} TH/s`, `Current pool hashrate: ${hashrateTH} TH/s`));
            } catch (err) {
                console.error('Fehler bei /poolhashrate:', err);
                this.bot.sendMessage(chatId, this.t(chatId, 'Konnte die Pool-Hashrate nicht abrufen.', 'Could not fetch pool hashrate.'));
            }
        });

        this.bot.onText(/\/stats (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const raw = match?.[1]?.trim();

            if (!raw) {
                this.bot.sendMessage(chatId, this.t(chatId, 'Befehl nicht erkannt, oder Wert fehlt', 'Command not recognized, or value missing'));
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt (Stats):", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.bot.sendMessage(chatId, this.t(chatId, 'Ungültige Adresse.', 'Invalid address.'));
                return;
            }

            try {
                const stats = await this.clientStatsAggregator.getStats(address);
                if (stats.workers === 0) {
                    this.bot.sendMessage(chatId, this.t(chatId, 'Keine aktiven Worker für diese Adresse gefunden.', 'No active workers found for this address.'));
                    return;
                }
                const lastShareTime = await this.clientStatisticsService.getLastShareTime(address);
                const lastSeenSeconds = lastShareTime ? Math.floor((Date.now() - lastShareTime) / 1000) : 0;
                const bestDifficultyG = (stats.bestever / 1e9).toFixed(2);
                const sharesText = this.numberSuffix.to(stats.shares);
                const rejectedText = this.numberSuffix.to(stats.rejected);

        const deText = `📈 Stats für deine Adresse:\n- Hashrate (1m): ${stats.hashrate1m}H\n- Letzter Share: vor ${lastSeenSeconds} Sekunden\n- Beste Difficulty: ${bestDifficultyG} G\n- Shares: ${sharesText}\n- Rejected: ${rejectedText}`;
        const enText = `📈 Stats for your address:\n- Hashrate (1m): ${stats.hashrate1m}H\n- Last share: ${lastSeenSeconds} seconds ago\n- Best difficulty: ${bestDifficultyG} G\n- Shares: ${sharesText}\n- Rejected: ${rejectedText}`;
        this.bot.sendMessage(chatId, this.t(chatId, deText, enText));
        } catch (err) {
                console.error("Fehler bei /stats:", err);
                this.bot.sendMessage(chatId, this.t(chatId, 'Fehler beim Abrufen der Statistiken.', 'Error fetching statistics.'));
            }
        });

        this.bot.on('message', async (msg) => {
            if (!msg.text) return;

            const text = msg.text.trim();

            if (
                text.startsWith('/subscribe ') ||
                text.startsWith('/subscribe_bestdiff ') ||
                text.startsWith('/stats ') ||
                text === '/subscribe' ||
                text === '/subscribe_bestdiff' ||
                text === '/stats' ||
                text === '/start' ||
                text === '/difficulty' ||
                text === '/next_difficulty' ||
                text === '/poolhashrate'
            ) {
                if (text === '/subscribe' || text === '/subscribe_bestdiff' || text === '/stats') {
                    this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Befehl nicht erkannt, oder Wert fehlt', 'Command not recognized, or value missing'));
                }
                return;
            }

            this.bot.sendMessage(msg.chat.id, this.t(msg.chat.id, 'Befehl nicht erkannt, oder Wert fehlt', 'Command not recognized, or value missing'));
        });
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (!this.bot) return;

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const subscriberMessages = subscribers.map(subscriber => {
            const text = this.t(subscriber.telegramChatId, `Block gefunden! Result: ${message}, Höhe: ${height}`, `Block found! Result: ${message}, height: ${height}`);
            return this.bot.sendMessage(subscriber.telegramChatId, text);
        });

        Promise.all(subscriberMessages).then();
    }

    public async notifySubscribersBestDiff(address: string, submissionDifficulty: number) {
        if (!this.bot || !this.diffNotifications) return;

        const currentBest = this.bestDiffCache.get(address) ?? 0;

        if (submissionDifficulty > currentBest) {
            this.bestDiffCache.set(address, submissionDifficulty);

            const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
            const subscriberMessages = subscribers
                .filter(subscriber => subscriber.bestDiffNotificationsEnabled)
                .map(subscriber => {
                    const text = this.t(subscriber.telegramChatId,
                        `🏆 Neue beste Difficulty für deine Adresse!\nWert: ${this.numberSuffix.to(submissionDifficulty)}`,
                        `🏆 New best difficulty for your address!\nValue: ${this.numberSuffix.to(submissionDifficulty)}`
                    );
                    return this.bot.sendMessage(subscriber.telegramChatId, text);
                });

            Promise.all(subscriberMessages).then();
        }
    }
}
