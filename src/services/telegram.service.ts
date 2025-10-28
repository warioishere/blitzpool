import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';
import { NumberSuffix } from '../utils/NumberSuffix';
import { decryptMessageIfNeeded } from '../utils/message-decryptor';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { StratumV1Service } from './stratum-v1.service';
import { NtfyService } from './ntfy.service';
import { buildStatsMessage, buildWorkersOverviewMessage } from './common-command-handlers';

@Injectable()
export class TelegramService implements OnModuleInit {
    private bot: TelegramBot;
    private diffNotifications: boolean;
    private numberSuffix: NumberSuffix;
    private bestDiffCache: Map<string, number> = new Map();
    private chatLanguages: Map<number, 'de' | 'en'> = new Map();
    private shouldRegisterHandlers = false;
    private readonly deviceNotificationFormatters: Record<'de' | 'en', Intl.DateTimeFormat>;

    private formatAddress(address: string): string {
        return `${address.slice(0, 4)}...${address.slice(-5)}`;
    }

    private getLanguage(chatId: number): 'de' | 'en' {
        return this.chatLanguages.get(chatId) ?? 'de';
    }

    private reply(chatId: number, messages: { de: string; en: string }) {
        const lang = this.getLanguage(chatId);
        return this.bot.sendMessage(chatId, messages[lang]);
    }

    private async resolveAddressForChat(chatId: number, addressParam?: string): Promise<string | null> {
        let raw = addressParam?.trim();

        if (raw) {
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                raw = decrypted.trim();
            }

            if (!validate(raw)) {
                await this.reply(chatId, {
                    de: 'Ungültige Adresse.',
                    en: 'Invalid address.'
                });
                return null;
            }

            return raw;
        }

        const defaultSub = await this.telegramSubscriptionsService.getDefault(chatId);
        if (defaultSub) {
            return defaultSub.address;
        }

        const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
        if (subs.length === 0) {
            await this.reply(chatId, {
                de: 'Keine Adresse gespeichert. Nutze /subscribe, um eine hinzuzufügen.',
                en: 'No address stored. Use /subscribe to add one.'
            });
            return null;
        }

        if (subs.length === 1) {
            return subs[0].address;
        }

        const list = subs.map(s => `${s.isDefault ? '*' : ''}${this.formatAddress(s.address)}`).join('\n');
        await this.reply(chatId, {
            de: `Mehrere Adressen gespeichert:\n${list}\nBitte Adresse angeben.`,
            en: `Multiple addresses stored:\n${list}\nPlease specify an address.`
        });
        return null;
    }

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly clientService: ClientService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientStatisticsService: ClientStatisticsService,
        @Inject(forwardRef(() => StratumV1Service))
        private readonly stratumV1Service: StratumV1Service,
        private readonly ntfyService: NtfyService
    ) {
        this.numberSuffix = new NumberSuffix();
        this.diffNotifications = (this.configService.get('TELEGRAM_DIFF_NOTIFICATIONS')?.toLowerCase() === 'true') || false;

        const timezonePreference = this.configService.get<string>('TELEGRAM_TIMEZONE')?.trim();
        const fallbackTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        let effectiveTimeZone = timezonePreference && timezonePreference.length > 0
            ? timezonePreference
            : fallbackTimeZone ?? 'UTC';

        const createFormatter = (locale: string, timeZone: string) =>
            new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone });

        try {
            this.deviceNotificationFormatters = {
                de: createFormatter('de-DE', effectiveTimeZone),
                en: createFormatter('en-US', effectiveTimeZone),
            };
        } catch {
            effectiveTimeZone = 'UTC';
            this.deviceNotificationFormatters = {
                de: createFormatter('de-DE', effectiveTimeZone),
                en: createFormatter('en-US', effectiveTimeZone),
            };
        }

        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');
        const pm2InstanceId = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID;
        const normalizedInstanceId = typeof pm2InstanceId === 'string' ? pm2InstanceId.trim() : undefined;
        const isPm2Worker = typeof normalizedInstanceId === 'string' && normalizedInstanceId.length > 0;

        if (!token || token.length < 1) {
            return;
        }

        this.shouldRegisterHandlers = !isPm2Worker || normalizedInstanceId === '0';
        const polling = this.shouldRegisterHandlers;

        this.bot = new TelegramBot(token, { polling });

        if (this.shouldRegisterHandlers) {
            console.log('Telegram bot init');
        } else {
            console.log(`Telegram bot init (polling disabled) for PM2 instance ${normalizedInstanceId}`);
        }

    }

    async onModuleInit(): Promise<void> {
        if (!this.bot) return;

        const addresses = await this.telegramSubscriptionsService.getAllAddresses();
        if (addresses.length > 0) {
            const values = await Promise.all(addresses.map(a => this.addressSettingsService.getSettings(a, false)));
            addresses.forEach((addr, idx) => {
                const best = values[idx]?.bestDifficulty ?? 0;
                this.bestDiffCache.set(addr, best);
            });
        }

        if (!this.shouldRegisterHandlers) {
            return;
        }

        // Telegram Menübefehle registrieren
        const commandsDe: TelegramBot.BotCommand[] = [
            { command: '/start', description: 'Zeigt Willkommensnachricht' },
            { command: '/subscribe', description: 'Benachrichtigung bei Blockhit aktivieren' },
            { command: '/subscribe_bestdiff', description: 'Best-Diff Benachrichtigungen (on/off, Standard: on)' },
            { command: '/bestdiff_reset', description: 'Best-Diff zurücksetzen' },
            { command: '/device_notifications', description: 'Geräte-Benachrichtigungen (on/off)' },
            { command: '/difficulty', description: 'Zeigt aktuelle Netzwerk-Difficulty' },
            { command: '/next_difficulty', description: 'Zeigt erwartete Änderung der Netzwerk-Difficulty' },
            { command: '/stats', description: 'Zeigt die Stats für deine Miner Adresse an' },
            { command: '/show_workers', description: 'Zeigt Worker-Übersicht' },
            { command: '/poolhashrate', description: 'Zeigt die aktuelle Pool-Hashrate' },
            { command: '/remove', description: 'Adresse entfernen' },
            { command: '/show_addresses', description: 'Zeigt gespeicherte Adressen' },
            { command: '/deutsch', description: 'Bot-Antworten auf Deutsch' },
            { command: '/english', description: 'Bot replies in English' },
            { command: '/encryption_help', description: 'Anleitung zum Verschlüsseln' }
        ];

        const commandsEn: TelegramBot.BotCommand[] = [
            { command: '/start', description: 'Show welcome message' },
            { command: '/subscribe', description: 'Enable block hit notifications' },
            { command: '/subscribe_bestdiff', description: 'Best-diff notifications (on/off, default: on)' },
            { command: '/bestdiff_reset', description: 'Reset best-diff counter' },
            { command: '/device_notifications', description: 'Device notifications (on/off)' },
            { command: '/difficulty', description: 'Show current network difficulty' },
            { command: '/next_difficulty', description: 'Show expected network difficulty change' },
            { command: '/stats', description: 'Show stats for your miner address' },
            { command: '/show_workers', description: 'Show worker overview' },
            { command: '/poolhashrate', description: 'Show current pool hashrate' },
            { command: '/remove', description: 'Remove address' },
            { command: '/show_addresses', description: 'Show stored addresses' },
            { command: '/deutsch', description: 'Bot replies in German' },
            { command: '/english', description: 'Bot replies in English' },
            { command: '/encryption_help', description: 'How to encrypt your address' }
        ];

        await this.bot.setMyCommands(commandsDe);
        await this.bot.setMyCommands(commandsDe, { language_code: 'de' });
        await this.bot.setMyCommands(commandsEn, { language_code: 'en' });

        this.bot.onText(/\/deutsch/, (msg) => {
            this.chatLanguages.set(msg.chat.id, 'de');
            this.reply(msg.chat.id, {
                de: 'Sprache auf Deutsch gestellt.',
                en: 'Language switched to German.'
            });
        });

        this.bot.onText(/\/english/, (msg) => {
            this.chatLanguages.set(msg.chat.id, 'en');
            this.reply(msg.chat.id, {
                de: 'Sprache auf Englisch gestellt.',
                en: 'Language switched to English.'
            });
        });

        this.bot.onText(/\/encryption_help/, (msg) => {
            this.reply(msg.chat.id, {
                de: `So verschlüsselst du deine BTC-Adresse:\n` +
                    `1. Nutze das Tool: https://github.com/warioishere/blitzpool-message-encryptor-for-TG\n` +
                    `   oder melde dich mit deiner BTC-Adresse auf dem Web-UI an und verwende den integrierten Verschlüssler.\n` +
                    `2. Sende mir dann /subscribe <verschlüsselte Adresse>`,
                en: `How to encrypt your BTC address:\n` +
                    `1. Use the tool: https://github.com/warioishere/blitzpool-message-encryptor-for-TG\n` +
                    `   or log in with your BTC address on the web UI and use the integrated encryptor.\n` +
                    `2. Then send /subscribe <encrypted address>`
            });
        });

        this.bot.onText(/^\/subscribe(?:\s+(.+))?$/, async (msg, match) => {
            const raw = match?.[1]?.trim();
            if (!raw) {
                this.reply(msg.chat.id, {
                    de: 'Bitte gib eine Adresse an.',
                    en: 'Please provide an address.'
                });
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt:", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.reply(msg.chat.id, {
                    de: 'Ungültige Adresse.',
                    en: 'Invalid address.'
                });
                return;
            }
            const existingForChat = await this.telegramSubscriptionsService.getChatSubscriptions(msg.chat.id);
            const wasSubscribed = existingForChat.some(s => s.address === address);

            await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
            const settings = await this.addressSettingsService.getSettings(address, false);
            this.bestDiffCache.set(address, settings?.bestDifficulty ?? 0);

            if (wasSubscribed) {
                this.reply(msg.chat.id, {
                    de: 'Adresse als Standard gesetzt!',
                    en: 'Address set as default!'
                });
            } else {
                this.reply(msg.chat.id, {
                    de: 'Benachrichtigung aktiviert!',
                    en: 'Notification enabled!'
                });
            }
        });

        this.bot.onText(/\/subscribe_bestdiff(?:\s+(on|off))?/i, async (msg, match) => {
            const chatId = msg.chat.id;
            const action = match?.[1]?.toLowerCase();

            if (!action || !['on', 'off'].includes(action)) {
                this.reply(chatId, {
                    de: "Bitte gib 'on' oder 'off' an.",
                    en: "Please provide 'on' or 'off'.",
                });
                return;
            }

            const enable = action === 'on';

            try {
                await this.telegramSubscriptionsService.updateBestDiffNotification(chatId, enable);
                this.reply(chatId, {
                    de: `Best Difficulty Benachrichtigungen wurden ${enable ? 'aktiviert' : 'deaktiviert'}.`,
                    en: `Best difficulty notifications ${enable ? 'enabled' : 'disabled'}.`
                });
            } catch (error) {
                console.error("Fehler bei /subscribe_bestdiff:", error);
                this.reply(chatId, {
                    de: 'Fehler beim Setzen der Einstellung. Bitte später erneut versuchen.',
                    en: 'Failed to update setting. Please try again later.'
                });
            }
        });

        this.bot.onText(/\/bestdiff_reset(?:\s+(.+))?/i, async (msg, match) => {
            const chatId = msg.chat.id;
            const addressParam = match?.[1];

            const address = await this.resolveAddressForChat(chatId, addressParam);
            if (!address) {
                return;
            }

            try {
                await this.addressSettingsService.updateBestDifficulty(address, 0, null);
                this.bestDiffCache.delete(address);
                this.ntfyService.resetBestDiffCache(address);
                await this.stratumV1Service.resetBestDifficultyForAddress(address);
                this.reply(chatId, {
                    de: `Best Difficulty für ${this.formatAddress(address)} zurückgesetzt.`,
                    en: `Best difficulty for ${this.formatAddress(address)} reset.`
                });
            } catch (error) {
                console.error('Fehler bei /bestdiff_reset:', error);
                this.reply(chatId, {
                    de: 'Fehler beim Zurücksetzen der Best Difficulty. Bitte später erneut versuchen.',
                    en: 'Failed to reset best difficulty. Please try again later.'
                });
            }
        });

        this.bot.onText(/\/device_notifications(?:\s+(\S+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            const action = match?.[1]?.toLowerCase();

            if (!action || !['on', 'off'].includes(action)) {
                this.reply(chatId, {
                    de: "Bitte gib 'on' oder 'off' an.",
                    en: "Please provide 'on' or 'off'.",
                });
                return;
            }

            const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            if (subs.length === 0) {
                this.reply(chatId, {
                    de: 'Keine Adresse gespeichert. Nutze /subscribe, um eine hinzuzufügen.',
                    en: 'No address stored. Use /subscribe to add one.'
                });
                return;
            }

            const enabled = action === 'on';

            try {
                await this.telegramSubscriptionsService.updateDeviceNotifications(chatId, enabled);
                this.reply(chatId, {
                    de: `Geräte-Benachrichtigungen ${enabled ? 'aktiviert' : 'deaktiviert'}.`,
                    en: `Device notifications ${enabled ? 'enabled' : 'disabled'}.`
                });
            } catch (error) {
                console.error('Fehler bei /device_notifications:', error);
                this.reply(chatId, {
                    de: 'Fehler beim Setzen der Einstellung. Bitte später erneut versuchen.',
                    en: 'Failed to update setting. Please try again later.'
                });
            }
        });

        this.bot.onText(/\/start/, (msg) => {
            this.reply(msg.chat.id, {
                de: `Willkommen beim BlitzPool Status Bot! 💡

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

Ich entschlüssle ihn und reagiere genau wie bei Klartext. 🔒`,
                en: `Welcome to the BlitzPool status bot! 💡

You can:
– message me directly (e.g. /subscribe BitcoinAddress)
– or send it encrypted (e.g. using the encryption tool)

🔐 You can also send the BTC worker address encrypted:
1. Read the README: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/blob/master/README.md
2a. Download the Python script for Linux and Mac: https://cloud.yourdevice.ch/s/TbqdwE24jTRmtRp
2b. Or for Windows: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/releases/tag/v1.0.0
3a. Run the script with './encrypt-message.py'
3b. Or on Windows double click the .exe
4. Enter your BTC address.
5. Send '/subscribe <encrypted address>' directly to me.
6. Send '/stats <encrypted address>' for your statistics.

I will decrypt it and respond just like with plain text. 🔒`
            });
        });

        this.bot.onText(/\/difficulty/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const res = await fetch('https://mempool.space/api/v1/mining/hashrate/3d');
                const json = await res.json();
                const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
                this.reply(chatId, {
                    de: `Aktuelle Difficulty: ${difficulty} T`,
                    en: `Current difficulty: ${difficulty} T`
                });
            } catch (e) {
                this.reply(chatId, {
                    de: 'Konnte die Difficulty nicht abrufen.',
                    en: 'Could not fetch difficulty.'
                });
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

                this.reply(chatId, {
                    de: `📊 Nächste Difficulty-Anpassung:

• Fortschritt: ${progress}%
• Geschätzt: ${estimatedDate}
• Erwartete Änderung: ${changeText}`,
                    en: `📊 Next difficulty adjustment:

• Progress: ${progress}%
• Estimated: ${estimatedDate}
• Expected change: ${changeText}`
                });
            } catch (err) {
                console.error("Fehler bei /next_difficulty:", err);
                this.reply(chatId, {
                    de: 'Konnte die nächste Difficulty-Anpassung nicht abrufen.',
                    en: 'Could not fetch next difficulty adjustment.'
                });
            }
        });

        this.bot.onText(/\/poolhashrate/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const apiPort = process.env.API_PORT || '3334';
                const res = await fetch(`http://localhost:${apiPort}/api/pool`);
                const data = await res.json();
                const hashrateTH = (data.totalHashRate / 1e12).toFixed(2);
                this.reply(chatId, {
                    de: `Aktuelle Pool-Hashrate: ${hashrateTH} TH/s`,
                    en: `Current pool hashrate: ${hashrateTH} TH/s`
                });
            } catch (err) {
                console.error('Fehler bei /poolhashrate:', err);
                this.reply(chatId, {
                    de: 'Konnte die Pool-Hashrate nicht abrufen.',
                    en: 'Could not fetch pool hashrate.'
                });
            }
        });

        this.bot.onText(/\/remove(?:\s+(.+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            const raw = match?.[1]?.trim();
            if (!raw) {
                this.reply(chatId, {
                    de: 'Bitte gib eine Adresse an.',
                    en: 'Please provide an address.'
                });
                return;
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) address = decrypted.trim();

            if (!validate(address)) {
                this.reply(chatId, {
                    de: 'Ungültige Adresse.',
                    en: 'Invalid address.'
                });
                return;
            }

            await this.telegramSubscriptionsService.removeSubscription(chatId, address);
            this.bestDiffCache.delete(address);
            this.reply(chatId, {
                de: 'Adresse entfernt.',
                en: 'Address removed.'
            });
        });

        this.bot.onText(/\/show_addresses/, async (msg) => {
            const chatId = msg.chat.id;
            const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            if (subs.length === 0) {
                this.reply(chatId, {
                    de: 'Keine Adresse gespeichert.',
                    en: 'No addresses stored.'
                });
                return;
            }
            const lines = subs.map(s => `${s.isDefault ? '*' : ''}${this.formatAddress(s.address)}`).join('\n');
            this.reply(chatId, {
                de: `Gespeicherte Adressen:\n${lines}\n* = Standard`,
                en: `Stored addresses:\n${lines}\n* = default`
            });
        });

        this.bot.onText(/\/show_workers(?:\s+(.+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            let raw = match?.[1]?.trim();

            if (!raw) {
                const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
                if (subs.length === 0) {
                    this.reply(chatId, {
                        de: 'Keine Adresse gespeichert. Nutze /subscribe, um eine hinzuzufügen.',
                        en: 'No address stored. Use /subscribe to add one.'
                    });
                    return;
                }

                const defaultSub = subs.find(s => s.isDefault);
                if (subs.length === 1 || defaultSub) {
                    raw = (defaultSub ?? subs[0]).address;
                } else {
                    const list = subs.map(s => `${s.isDefault ? '*' : ''}${this.formatAddress(s.address)}`).join('\n');
                    this.reply(chatId, {
                        de: `Mehrere Adressen gespeichert:\n${list}\nBitte Adresse angeben.`,
                        en: `Multiple addresses stored:\n${list}\nPlease specify an address.`
                    });
                    return;
                }
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log('Entschlüsselt (Show Workers):', decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.reply(chatId, {
                    de: 'Ungültige Adresse.',
                    en: 'Invalid address.'
                });
                return;
            }

            const apiPort = process.env.API_PORT ?? '3334';
            const url = `http://localhost:${apiPort}/api/client/${encodeURIComponent(address)}`;

            try {
                const res = await fetch(url);
                if (!res.ok) {
                    this.reply(chatId, {
                        de: 'Konnte Worker-Daten nicht abrufen.',
                        en: 'Could not fetch worker data.'
                    });
                    return;
                }
                const payload = await res.json();
                if (!payload || !Array.isArray(payload.workers) || payload.workers.length === 0) {
                    this.reply(chatId, {
                        de: 'Keine Worker für diese Adresse gefunden.',
                        en: 'No workers found for this address.'
                    });
                    return;
                }

                const messages = buildWorkersOverviewMessage(payload, this.numberSuffix);
                this.reply(chatId, messages);
            } catch (err) {
                console.error('Fehler bei /show_workers:', err);
                this.reply(chatId, {
                    de: 'Fehler beim Abrufen der Worker-Daten.',
                    en: 'Failed to retrieve worker data.'
                });
            }
        });

        this.bot.onText(/\/stats(?:\s+(.+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            let raw = match?.[1]?.trim();

            if (!raw) {
                const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
                if (subs.length === 0) {
                    this.reply(chatId, {
                        de: 'Keine Adresse gespeichert. Nutze /subscribe, um eine hinzuzufügen.',
                        en: 'No address stored. Use /subscribe to add one.'
                    });
                    return;
                }

                const defaultSub = subs.find(s => s.isDefault);
                if (subs.length === 1 || defaultSub) {
                    raw = (defaultSub ?? subs[0]).address;
                } else {
                    const list = subs.map(s => `${s.isDefault ? '*' : ''}${this.formatAddress(s.address)}`).join('\n');
                    this.reply(chatId, {
                        de: `Mehrere Adressen gespeichert:\n${list}\nBitte Adresse angeben.`,
                        en: `Multiple addresses stored:\n${list}\nPlease specify an address.`
                    });
                    return;
                }
            }

            let address = raw;
            const decrypted = decryptMessageIfNeeded(raw);
            if (decrypted) {
                console.log("Entschlüsselt (Stats):", decrypted);
                address = decrypted.trim();
            }

            if (!validate(address)) {
                this.reply(chatId, {
                    de: 'Ungültige Adresse.',
                    en: 'Invalid address.'
                });
                return;
            }

            try {
                const messages = await buildStatsMessage(
                    address,
                    this.clientService,
                    this.addressSettingsService,
                    this.clientStatisticsService,
                    this.numberSuffix
                );
                if (!messages) {
                    this.reply(chatId, {
                        de: 'Keine aktiven Worker für diese Adresse gefunden.',
                        en: 'No active workers found for this address.'
                    });
                    return;
                }
                this.reply(chatId, messages);
            } catch (err) {
                console.error("Fehler bei /stats:", err);
                this.reply(chatId, {
                    de: 'Fehler beim Abrufen der Statistiken.',
                    en: 'Failed to retrieve statistics.'
                });
            }
        });

        this.bot.on('message', async (msg) => {
            if (!msg.text) return;

            const text = msg.text.trim();

            if (
                text.startsWith('/subscribe ') ||
                text.startsWith('/subscribe_bestdiff') ||
                text.startsWith('/device_notifications') ||
                text.startsWith('/bestdiff_reset') ||
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
            return this.bot.sendMessage(
                subscriber.telegramChatId,
                this.getLanguage(subscriber.telegramChatId) === 'de'
                    ? `Block gefunden! Result: ${message}, Höhe: ${height}`
                    : `Block found! Result: ${message}, Height: ${height}`
            );
        });

        Promise.all(subscriberMessages).then();
    }

    public async notifySubscribersBestDiff(address: string, submissionDifficulty: number) {
        if (!this.bot || !this.diffNotifications) return;

        const settings = await this.addressSettingsService.getSettings(address, false);
        const persistedBest = settings?.bestDifficulty ?? 0;

        this.bestDiffCache.set(address, persistedBest);

        if (submissionDifficulty > persistedBest) {
            this.bestDiffCache.set(address, submissionDifficulty);

            const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
            const subscriberMessages = subscribers
                .filter(sub => sub.bestDiffNotificationsEnabled)
                .map(async sub => {
                    const chatSubs = await this.telegramSubscriptionsService.getChatSubscriptions(sub.telegramChatId);
                    const includeAddress = chatSubs.length > 1;
                    const formatted = this.formatAddress(address);
                    const msg = this.getLanguage(sub.telegramChatId) === 'de'
                        ? includeAddress
                            ? `🏆 Neue beste Difficulty für Adresse ${formatted}!\nWert: ${this.numberSuffix.to(submissionDifficulty)}`
                            : `🏆 Neue beste Difficulty für deine Adresse!\nWert: ${this.numberSuffix.to(submissionDifficulty)}`
                        : includeAddress
                            ? `🏆 New best difficulty for address ${formatted}!\nValue: ${this.numberSuffix.to(submissionDifficulty)}`
                            : `🏆 New best difficulty for your address!\nValue: ${this.numberSuffix.to(submissionDifficulty)}`;
                    return this.bot.sendMessage(sub.telegramChatId, msg);
                });

            Promise.all(subscriberMessages).then();
        }
    }

    public async notifyDeviceStatusChange(params: {
        address: string;
        workerName?: string;
        userAgent?: string;
        sessionId: string;
        isOnline: boolean;
        timestamp: Date;
    }): Promise<void> {
        if (!this.bot) return;

        const { address, workerName, userAgent, isOnline, timestamp } = params;
        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const interestedSubscribers = subscribers.filter(sub => sub.deviceNotificationsEnabled);
        if (interestedSubscribers.length === 0) {
            return;
        }

        const eventTime = timestamp instanceof Date ? timestamp : new Date(timestamp);
        const timeDe = this.deviceNotificationFormatters.de.format(eventTime);
        const timeEn = this.deviceNotificationFormatters.en.format(eventTime);
        const trimmedAgent = userAgent?.trim();
        const trimmedWorker = workerName?.trim();
        const formattedAddress = this.formatAddress(address);
        const chatIncludeCache = new Map<number, boolean>();

        const notifications = interestedSubscribers.map(async sub => {
            let includeAddress = chatIncludeCache.get(sub.telegramChatId);
            if (includeAddress === undefined) {
                const chatSubscriptions = await this.telegramSubscriptionsService.getChatSubscriptions(sub.telegramChatId);
                includeAddress = chatSubscriptions.length > 1;
                chatIncludeCache.set(sub.telegramChatId, includeAddress);
            }

            const suffixDe = includeAddress ? ` – Adresse ${formattedAddress}` : '';
            const suffixEn = includeAddress ? ` – address ${formattedAddress}` : '';
            const lang = this.getLanguage(sub.telegramChatId);

            const userAgentDe = trimmedAgent && trimmedAgent.length > 0 ? trimmedAgent : 'unbekannt';
            const userAgentEn = trimmedAgent && trimmedAgent.length > 0 ? trimmedAgent : 'unknown';
            const workerDe = trimmedWorker && trimmedWorker.length > 0 ? trimmedWorker : 'unbekannt';
            const workerEn = trimmedWorker && trimmedWorker.length > 0 ? trimmedWorker : 'unknown';

            const messageDe = isOnline
                ? `📶 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeDe} wieder online${suffixDe}.`
                : `📴 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeDe} offline${suffixDe}.`;
            const messageEn = isOnline
                ? `📶 Device with ${userAgentEn} (worker ${workerEn}) back online at ${timeEn}${suffixEn}.`
                : `📴 Device with ${userAgentEn} (worker ${workerEn}) went offline at ${timeEn}${suffixEn}.`;

            return this.bot.sendMessage(sub.telegramChatId, lang === 'de' ? messageDe : messageEn);
        });

        await Promise.all(notifications);
    }
}
