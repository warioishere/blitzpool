import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';
import { NumberSuffix } from '../utils/NumberSuffix';
import { decryptMessageIfNeeded } from '../utils/message-decryptor';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';

@Injectable()
export class TelegramService implements OnModuleInit {
    private bot: TelegramBot;
    private diffNotifications: boolean;
    private numberSuffix: NumberSuffix;
    private bestDiffCache: Map<string, number> = new Map();

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
	private readonly clientService: ClientService,
        private readonly addressSettingsService: AddressSettingsService
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
            { command: '/subscribe', description: 'Benachrichtigung bei Blockhit aktivieren' },
            { command: '/subscribe_bestdiff', description: 'Best-Diff Benachrichtigungen (on/off, Standard: on)' },
            { command: '/difficulty', description: 'Zeigt aktuelle Netzwerk-Difficulty' },
            { command: '/next_difficulty', description: 'Zeigt erwartete Änderung der Netzwerk-Difficulty' },
	    { command: '/stats', description: 'Zeigt die Stats für deine Miner Adresse an' }
        ]);

        this.bot.onText(/\/subscribe (.+)/, async (msg, match) => {
            const raw = match?.[1]?.trim();
            if (!raw) {
                this.bot.sendMessage(msg.chat.id, "Bitte gib eine Adresse an.");
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt:", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.bot.sendMessage(msg.chat.id, "Ungültige Adresse.");
                return;
            }

            const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
            if (subscribers.length === 0) {
                await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
                this.bot.sendMessage(msg.chat.id, "Benachrichtigung aktiviert!");
            } else {
                this.bot.sendMessage(msg.chat.id, "Bereits registriert!");
            }
        });

        this.bot.onText(/\/subscribe_bestdiff (on|off)/i, async (msg, match) => {
            const chatId = msg.chat.id;
            const value = match?.[1]?.toLowerCase();

            if (!value) {
                this.bot.sendMessage(chatId, "Bitte gib 'on' oder 'off' an.");
                return;
            }

            const enable = value === 'on';

            try {
                await this.telegramSubscriptionsService.updateBestDiffNotification(chatId, enable);
                this.bot.sendMessage(chatId, `Best Difficulty Benachrichtigungen wurden ${enable ? 'aktiviert' : 'deaktiviert'}.`);
            } catch (error) {
                console.error("Fehler bei /subscribe_bestdiff:", error);
                this.bot.sendMessage(chatId, "Fehler beim Setzen der Einstellung. Bitte später erneut versuchen.");
            }
        });

        this.bot.onText(/\/start/, (msg) => {
            this.bot.sendMessage(msg.chat.id,
`Willkommen beim BlitzPool Status Bot! 💡

Du kannst mir:
– direkt schreiben (z. B. /subscribe BitcoinAdresse)
– oder verschlüsselt senden (z. B. über das Verschlüsselungstool)

🔐 Du kannst mir die BTC Worker Adresse auch verschlüsselt senden:
1. Lesst euch die README durch: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/blob/master/README.md
2a. Ladet den Python-Script für Linux und Mac herunter: https://cloud.yourdevice.ch/s/TbqdwE24jTRmtRp
2b. Oder für Windows: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/releases/tag/v1.0.0
3a. Führt den Script im Terminal aus mit './encrypt-message.py'
3b. Oder auf Windows mit Doppelklick auf die .exe
4. Gebt eure BTC-Adresse ein.
5. Sende '/subscribe <verschlüsselte Adresse>' direkt an mich.
6. Sende '/stats <verschlüsselte Adresse>' für deine Statistiken.

Ich entschlüssle ihn und reagiere genau wie bei Klartext. 🔒`);
        });

        this.bot.onText(/\/difficulty/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const res = await fetch('https://mempool.space/api/v1/mining/hashrate/3d');
                const json = await res.json();
                const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
                this.bot.sendMessage(chatId, `Aktuelle Difficulty: ${difficulty} T`);
            } catch (e) {
                this.bot.sendMessage(chatId, "Konnte die Difficulty nicht abrufen.");
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
                const estimatedDate = new Date(data.estimatedRetargetDate * 1000).toLocaleString('de-CH');

                const changeText = change >= 0 ? `📈 +${change}%` : `📉 ${change}%`;

                this.bot.sendMessage(chatId,
`📊 Nächste Difficulty-Anpassung:

• Fortschritt: ${progress}%
• Geschätzt: ${estimatedDate}
• Erwartete Änderung: ${changeText}`);
            } catch (err) {
                console.error("Fehler bei /next_difficulty:", err);
                this.bot.sendMessage(chatId, "Konnte die nächste Difficulty-Anpassung nicht abrufen.");
            }
        });

	this.bot.onText(/\/stats (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const raw = match?.[1]?.trim();

            if (!raw) {
                this.bot.sendMessage(chatId, "Bitte gib eine BTC-Adresse an.");
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt (Stats):", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.bot.sendMessage(chatId, "Ungültige Adresse.");
                return;
            }

            try {
                const workers = await this.clientService.getByAddress(address);
                const addressSettings = await this.addressSettingsService.getSettings(address, false);

                if (!workers || workers.length === 0) {
                    this.bot.sendMessage(chatId, "Keine aktiven Worker für diese Adresse gefunden.");
                    return;
                }

                const totalHashrate = workers.reduce((sum, w) => sum + (w.hashRate ?? 0), 0);
                const totalHashrateTH = totalHashrate / 1e12;

                const lastSeenSeconds = Math.floor((Date.now() - new Date(workers[0].updatedAt).getTime()) / 1000);

                const bestDiffRaw = addressSettings?.bestDifficulty ?? 0;
                const bestDifficultyG = bestDiffRaw / 1e9;

        this.bot.sendMessage(chatId,
`📈 Stats für deine Adresse:
- Aktuelle Hashrate: ${totalHashrateTH.toFixed(2)} TH/s
- Letzter Share: vor ${lastSeenSeconds} Sekunden
- Beste Difficulty: ${bestDifficultyG.toFixed(2)} G`);
        } catch (err) {
                console.error("Fehler bei /stats:", err);
                this.bot.sendMessage(chatId, "Fehler beim Abrufen der Statistiken.");
            }
        });

        this.bot.on('message', async (msg) => {
            if (!msg.text) return;

            const text = msg.text.trim();

            if (
                text.startsWith('/subscribe ') ||
                text.startsWith('/subscribe_bestdiff') ||
                text === '/subscribe' ||
                text === '/start' ||
                text === '/difficulty' ||
                text === '/next_difficulty'
            ) {
                return;
            }

            console.log("Unverarbeitete Nachricht:", text);
        });
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (!this.bot) return;

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const subscriberMessages = subscribers.map(subscriber => {
            return this.bot.sendMessage(subscriber.telegramChatId, `Block gefunden! Result: ${message}, Höhe: ${height}`);
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
                    return this.bot.sendMessage(
                        subscriber.telegramChatId,
                        `🏆 Neue beste Difficulty für deine Adresse!\nWert: ${this.numberSuffix.to(submissionDifficulty)}`
                    );
                });

            Promise.all(subscriberMessages).then();
        }
    }
}
