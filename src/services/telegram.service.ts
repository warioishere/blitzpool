import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';
import { NumberSuffix } from '../utils/NumberSuffix';
import { decryptMessageIfNeeded } from '../utils/message-decryptor';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { TelegramSubscriptionsEntity } from '../ORM/telegram-subscriptions/telegram-subscriptions.entity';
import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { BestDifficultyTrackerService } from '../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { StratumV1Service } from './stratum-v1.service';
import { StratumV2Service } from './stratum-v2.service';
import { NtfyService } from './ntfy.service';
import { PplnsService } from './pplns.service';
import { GroupService } from './group.service';
import { GroupSoloService } from './group-solo.service';
import { buildStatsMessage, buildWorkersOverviewMessage } from './common-command-handlers';

@Injectable()
export class TelegramService implements OnModuleInit {
    private bot: TelegramBot;
    private diffNotifications: boolean;
    private numberSuffix: NumberSuffix;
    private bestDiffCache: Map<string, number> = new Map();
    private chatLanguages: Map<number, 'de' | 'en'> = new Map();
    // Short-lived map for pending /bestdiff_reset confirmations.
    // Bitcoin addresses don't fit in callback_data (64-byte limit), so the
    // address is held here keyed by chatId:messageId and looked up on tap.
    private pendingBestdiffResets: Map<string, { address: string; expiresAt: number }> = new Map();
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

    private async sendHourlyReportsForChat(chatId: number, showStats: boolean, showWorkers: boolean): Promise<void> {
        try {
            const address = await this.resolveAddressForChat(chatId);
            if (!address) return;

            if (showStats) {
                try {
                    const messages = await buildStatsMessage(
                        address,
                        this.clientService,
                        this.addressSettingsService,
                        this.clientStatisticsService,
                        this.numberSuffix
                    );
                    if (messages) {
                        this.bot.sendMessage(chatId, messages[this.getLanguage(chatId)]);
                    }
                } catch (err) {
                    console.error(`Error sending initial stats to ${chatId}:`, err);
                }
            }

            if (showWorkers) {
                try {
                    const apiPort = process.env.API_PORT ?? '3334';
                    const url = `http://localhost:${apiPort}/api/client/${encodeURIComponent(address)}`;
                    const res = await fetch(url);

                    if (res.ok) {
                        const payload = await res.json();
                        if (payload && Array.isArray(payload.workers) && payload.workers.length > 0) {
                            const messages = buildWorkersOverviewMessage(payload, this.numberSuffix);
                            this.bot.sendMessage(chatId, messages[this.getLanguage(chatId)]);
                        }
                    }
                } catch (err) {
                    console.error(`Error sending initial workers to ${chatId}:`, err);
                }
            }
        } catch (err) {
            console.error(`Error sending hourly reports for chat ${chatId}:`, err);
        }
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
        private readonly trackerService: BestDifficultyTrackerService,
        @Inject(forwardRef(() => StratumV1Service))
        private readonly stratumV1Service: StratumV1Service,
        @Inject(forwardRef(() => StratumV2Service))
        private readonly stratumV2Service: StratumV2Service,
        private readonly ntfyService: NtfyService,
        private readonly pplnsService: PplnsService,
        private readonly groupService: GroupService,
        private readonly groupSoloService: GroupSoloService,
    ) {
        this.numberSuffix = new NumberSuffix();
        this.diffNotifications = (this.configService.get('TELEGRAM_DIFF_NOTIFICATIONS')?.toLowerCase() === 'true') || false;

        const timezonePreference = this.configService.get<string>('TELEGRAM_TIMEZONE')?.trim();
        const fallbackTimeZone = 'Europe/Zurich';
        let effectiveTimeZone = timezonePreference && timezonePreference.length > 0
            ? timezonePreference
            : fallbackTimeZone;

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

        if (!token || token.length < 1) {
            return;
        }

        this.shouldRegisterHandlers = true;
        this.bot = new TelegramBot(token, { polling: true });

        this.bot.on('polling_error', (error) => {
            console.error('[Telegram] Polling error (non-fatal):', error.message);
        });
        this.bot.on('error', (error) => {
            console.error('[Telegram] Bot error (non-fatal):', error.message);
        });

        console.log('Telegram bot init');

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
            { command: '/send_hourly', description: 'Stündliche Stats/Worker-Berichte (Menü)' },
            { command: '/poolhashrate', description: 'Zeigt die aktuelle Pool-Hashrate' },
            { command: '/pplns_status', description: 'PPLNS-Status für deine Adresse' },
            { command: '/pplns_top', description: 'Top 10 Miner im PPLNS-Window' },
            { command: '/group_status', description: 'Status der Gruppe deiner Adresse' },
            { command: '/group_members', description: 'Mitglieder deiner Gruppe' },
            { command: '/group_history', description: 'Block-Auszahlungen deiner Gruppe' },
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
            { command: '/send_hourly', description: 'Hourly stats/worker reports (menu)' },
            { command: '/poolhashrate', description: 'Show current pool hashrate' },
            { command: '/pplns_status', description: 'PPLNS status for your address' },
            { command: '/pplns_top', description: 'Top 10 miners in PPLNS window' },
            { command: '/group_status', description: 'Status of the group your address belongs to' },
            { command: '/group_members', description: 'Members of your group' },
            { command: '/group_history', description: 'Block payouts of your group' },
            { command: '/remove', description: 'Remove address' },
            { command: '/show_addresses', description: 'Show stored addresses' },
            { command: '/deutsch', description: 'Bot replies in German' },
            { command: '/english', description: 'Bot replies in English' },
            { command: '/encryption_help', description: 'How to encrypt your address' }
        ];

        await this.bot.setMyCommands(commandsDe);
        await this.bot.setMyCommands(commandsDe, { language_code: 'de' });
        await this.bot.setMyCommands(commandsEn, { language_code: 'en' });

        // Replace any previously configured web-app menu button with the
        // built-in commands menu, so tapping the menu icon shows the bot
        // commands directly. Typings on node-telegram-bot-api 0.61 don't
        // expose this method statically.
        const setMenuButton = (this.bot as any).setChatMenuButton;
        if (typeof setMenuButton === 'function') {
            try {
                await setMenuButton.call(this.bot, { menu_button: { type: 'commands' } });
            } catch (err) {
                console.error('[Telegram] setChatMenuButton failed:', (err as Error).message);
            }
        }

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
                    `1. Logge dich im Web-UI mit deiner BTC-Adresse ein.\n` +
                    `2. Nutze den dort integrierten Verschlüssler — kopiere den ausgegebenen Text.\n` +
                    `3. Sende mir: /subscribe <verschlüsselte Adresse>`,
                en: `How to encrypt your BTC address:\n` +
                    `1. Log in to the web UI with your BTC address.\n` +
                    `2. Use the integrated encryptor — copy the resulting text.\n` +
                    `3. Send me: /subscribe <encrypted address>`
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

            const lang = this.getLanguage(chatId);
            const trimmed = this.formatAddress(address);
            const text = lang === 'de'
                ? `Best Difficulty für ${trimmed} wirklich zurücksetzen?`
                : `Really reset best difficulty for ${trimmed}?`;
            const reply_markup: TelegramBot.InlineKeyboardMarkup = {
                inline_keyboard: [[
                    {
                        text: lang === 'de' ? '✅ Ja, zurücksetzen' : '✅ Yes, reset',
                        callback_data: 'bdr:yes',
                    },
                    {
                        text: lang === 'de' ? '❌ Abbrechen' : '❌ Cancel',
                        callback_data: 'bdr:no',
                    },
                ]],
            };
            try {
                const sent = await this.bot.sendMessage(chatId, text, { reply_markup });
                this.pendingBestdiffResets.set(`${chatId}:${sent.message_id}`, {
                    address,
                    expiresAt: Date.now() + 5 * 60 * 1000,
                });
            } catch (err) {
                console.error('[Telegram] /bestdiff_reset prompt failed:', (err as Error).message);
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

Erste Schritte:
1. Adresse hinzufügen: /subscribe <bc1q…>
2. Adressen verwalten: /show_addresses (Tap zum Wechseln/Entfernen)
3. Alle Befehle: tippe auf das Menü-Icon ☰ unten links

🔐 Adresse verschlüsselt senden? /encryption_help
🌐 Sprache: /deutsch / /english`,
                en: `Welcome to the BlitzPool status bot! 💡

Getting started:
1. Add an address: /subscribe <bc1q…>
2. Manage addresses: /show_addresses (tap to switch/remove)
3. All commands: tap the menu icon ☰ at the bottom left

🔐 Send an encrypted address? /encryption_help
🌐 Language: /deutsch / /english`
            });
        });

        this.bot.onText(/\/pplns_status(?:\s+(.+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            await this.handlePplnsStatus(chatId, match?.[1]?.trim());
        });

        this.bot.onText(/\/pplns_top/, async (msg) => {
            await this.handlePplnsTop(msg.chat.id);
        });

        this.bot.onText(/\/group_status(?:\s+(.+))?/, async (msg, match) => {
            await this.handleGroupStatus(msg.chat.id, match?.[1]?.trim());
        });

        this.bot.onText(/\/group_members(?:\s+(.+))?/, async (msg, match) => {
            await this.handleGroupMembers(msg.chat.id, match?.[1]?.trim());
        });

        this.bot.onText(/\/group_history(?:\s+(.+))?/, async (msg, match) => {
            await this.handleGroupHistory(msg.chat.id, match?.[1]?.trim());
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

            const removed = await this.telegramSubscriptionsService.removeSubscription(chatId, address);
            if (removed) {
                this.bestDiffCache.delete(address);
                this.reply(chatId, {
                    de: 'Adresse entfernt.',
                    en: 'Address removed.'
                });
            } else {
                this.reply(chatId, {
                    de: 'Adresse war nicht gespeichert.',
                    en: 'Address was not saved.'
                });
            }
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
            const lang = this.getLanguage(chatId);
            const { text, reply_markup } = this.buildAddressKeyboardMessage(subs, lang);
            await this.bot.sendMessage(chatId, text, { reply_markup });
        });

        this.bot.on('callback_query', async (query) => {
            const data = query.data ?? '';
            if (data.startsWith('addr:')) await this.handleAddressCallback(query);
            else if (data.startsWith('bdr:')) await this.handleBestdiffResetCallback(query);
            else if (data.startsWith('hr:')) await this.handleHourlyCallback(query);
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

        this.bot.onText(/^\/send_hourly\b.*$/, async (msg) => {
            const chatId = msg.chat.id;
            const lang = this.getLanguage(chatId);

            const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            if (subs.length === 0) {
                this.reply(chatId, {
                    de: 'Keine Adresse gespeichert. Nutze /subscribe, um eine hinzuzufügen.',
                    en: 'No address stored. Use /subscribe to add one.'
                });
                return;
            }

            try {
                const { text, reply_markup } = this.buildHourlyMenu(subs[0], lang);
                await this.bot.sendMessage(chatId, text, { reply_markup });
            } catch (err) {
                console.error('[Telegram] /send_hourly menu failed:', (err as Error).message);
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
        isReturning?: boolean;
    }): Promise<void> {
        if (!this.bot) return;

        const { address, workerName, userAgent, isOnline, timestamp, isReturning } = params;
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
                ? `📶 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeDe} ${isReturning ? 'wieder ' : ''}online${suffixDe}.`
                : `📴 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeDe} offline${suffixDe}.`;
            const messageEn = isOnline
                ? `📶 Device with ${userAgentEn} (worker ${workerEn}) ${isReturning ? 'back ' : ''}online at ${timeEn}${suffixEn}.`
                : `📴 Device with ${userAgentEn} (worker ${workerEn}) went offline at ${timeEn}${suffixEn}.`;

            return this.bot.sendMessage(sub.telegramChatId, lang === 'de' ? messageDe : messageEn);
        });

        await Promise.all(notifications);
    }

    @Interval(60 * 60 * 1000) // Run every hour
    private async sendHourlyUpdates(): Promise<void> {
        if (!this.bot || !this.shouldRegisterHandlers) return;

        try {
            const enabledChats = await this.telegramSubscriptionsService.getHourlyEnabledChats();

            for (const chat of enabledChats) {
                try {
                    // Send stats if enabled
                    if (chat.hourlyStatsEnabled) {
                        try {
                            const messages = await buildStatsMessage(
                                chat.address,
                                this.clientService,
                                this.addressSettingsService,
                                this.clientStatisticsService,
                                this.numberSuffix
                            );
                            if (messages) {
                                this.bot.sendMessage(chat.telegramChatId, messages[this.getLanguage(chat.telegramChatId)]);
                            }
                        } catch (err) {
                            console.error(`Fehler beim Senden von Stats für ${chat.address} an Chat ${chat.telegramChatId}:`, err);
                        }
                    }

                    // Send workers overview if enabled
                    if (chat.hourlyWorkersEnabled) {
                        try {
                            const apiPort = process.env.API_PORT ?? '3334';
                            const url = `http://localhost:${apiPort}/api/client/${encodeURIComponent(chat.address)}`;
                            const res = await fetch(url);

                            if (res.ok) {
                                const payload = await res.json();
                                if (payload && Array.isArray(payload.workers) && payload.workers.length > 0) {
                                    const messages = buildWorkersOverviewMessage(payload, this.numberSuffix);
                                    this.bot.sendMessage(chat.telegramChatId, messages[this.getLanguage(chat.telegramChatId)]);
                                }
                            }
                        } catch (err) {
                            console.error(`Fehler beim Senden von Workers für ${chat.address} an Chat ${chat.telegramChatId}:`, err);
                        }
                    }
                } catch (err) {
                    console.error(`Fehler beim Verarbeiten von Stundlich-Updates für Chat ${chat.telegramChatId}:`, err);
                }
            }
        } catch (err) {
            console.error('Fehler beim Ausführen der Stundlich-Benachrichtigungen:', err);
        }
    }

    // ── PPLNS / Group-Solo command handlers ──────────────────────────
    //
    // All handlers respect the trim-only rule for outbound addresses
    // (`formatAddress`) and accept either plain or encrypted address
    // arguments via the existing `resolveAddressForChat` helper.

    private formatSats(sats: number): string {
        const sign = sats < 0 ? '-' : '';
        return `${sign}${Math.abs(sats).toLocaleString('en-US')}`;
    }

    private formatHashrate(hashRate: number): string {
        const th = (hashRate ?? 0) / 1e12;
        return `${th.toFixed(2)} TH/s`;
    }

    private buildAddressKeyboardMessage(
        subs: TelegramSubscriptionsEntity[],
        lang: 'de' | 'en',
    ): { text: string; reply_markup: TelegramBot.InlineKeyboardMarkup } {
        const sorted = [...subs].sort((a, b) => a.id - b.id);
        const inline_keyboard = sorted.map(s => ([
            {
                text: `${s.isDefault ? '⭐ ' : ''}${this.formatAddress(s.address)}`,
                callback_data: `addr:set:${s.id}`,
            },
            {
                text: '🗑',
                callback_data: `addr:rm:${s.id}`,
            },
        ]));
        const text = lang === 'de'
            ? 'Gespeicherte Adressen — tippe auf eine Adresse, um sie als Standard zu setzen, 🗑 zum Entfernen.\n⭐ = Standard'
            : 'Stored addresses — tap an address to set it as default, 🗑 to remove.\n⭐ = default';
        return { text, reply_markup: { inline_keyboard } };
    }

    private async handleAddressCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const data = query.data ?? '';
        if (!data.startsWith('addr:')) return;

        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        if (!chatId || !messageId) return;

        const lang = this.getLanguage(chatId);
        try {
            const m = data.match(/^addr:(set|rm):(\d+)$/);
            if (!m) {
                await this.bot.answerCallbackQuery(query.id);
                return;
            }
            const action = m[1] as 'set' | 'rm';
            const id = parseInt(m[2], 10);

            const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            const target = subs.find(s => s.id === id);
            if (!target) {
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? 'Adresse nicht mehr vorhanden.' : 'Address no longer exists.',
                });
                return;
            }

            const trimmed = this.formatAddress(target.address);
            if (action === 'set') {
                if (target.isDefault) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: lang === 'de' ? `${trimmed} ist schon Standard.` : `${trimmed} is already default.`,
                    });
                    return;
                }
                await this.telegramSubscriptionsService.saveSubscription(chatId, target.address);
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? `Standard: ${trimmed}` : `Default: ${trimmed}`,
                });
            } else {
                const removed = await this.telegramSubscriptionsService.removeSubscription(chatId, target.address);
                await this.bot.answerCallbackQuery(query.id, {
                    text: removed
                        ? (lang === 'de' ? `${trimmed} entfernt.` : `${trimmed} removed.`)
                        : (lang === 'de' ? `${trimmed} nicht gefunden.` : `${trimmed} not found.`),
                });
            }

            const fresh = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            if (fresh.length === 0) {
                await this.bot.editMessageText(
                    lang === 'de' ? 'Keine Adresse gespeichert.' : 'No addresses stored.',
                    { chat_id: chatId, message_id: messageId },
                );
                return;
            }
            const { text, reply_markup } = this.buildAddressKeyboardMessage(fresh, lang);
            await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup,
            });
        } catch (err) {
            console.error('[Telegram] callback_query failed:', (err as Error).message);
            try { await this.bot.answerCallbackQuery(query.id); } catch {}
        }
    }

    private buildHourlyMenu(
        sub: TelegramSubscriptionsEntity,
        lang: 'de' | 'en',
    ): { text: string; reply_markup: TelegramBot.InlineKeyboardMarkup } {
        const statsOn = sub.hourlyStatsEnabled;
        const workersOn = sub.hourlyWorkersEnabled;
        const statsLabel = lang === 'de'
            ? `Stats: ${statsOn ? '✅ AN' : '❌ AUS'}`
            : `Stats: ${statsOn ? '✅ ON' : '❌ OFF'}`;
        const workersLabel = lang === 'de'
            ? `Worker: ${workersOn ? '✅ AN' : '❌ AUS'}`
            : `Workers: ${workersOn ? '✅ ON' : '❌ OFF'}`;
        const text = lang === 'de'
            ? 'Stündliche Berichte — tippe zum Umschalten:'
            : 'Hourly reports — tap to toggle:';
        return {
            text,
            reply_markup: {
                inline_keyboard: [[
                    { text: statsLabel, callback_data: 'hr:stats' },
                    { text: workersLabel, callback_data: 'hr:workers' },
                ]],
            },
        };
    }

    private async handleHourlyCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const data = query.data ?? '';
        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        if (!chatId || !messageId) return;
        const lang = this.getLanguage(chatId);

        try {
            const subs = await this.telegramSubscriptionsService.getChatSubscriptions(chatId);
            if (subs.length === 0) {
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? 'Keine Adresse gespeichert.' : 'No address stored.',
                });
                return;
            }
            const current = subs[0];
            let newStats = current.hourlyStatsEnabled;
            let newWorkers = current.hourlyWorkersEnabled;
            if (data === 'hr:stats') newStats = !newStats;
            else if (data === 'hr:workers') newWorkers = !newWorkers;
            else { await this.bot.answerCallbackQuery(query.id); return; }

            const wasEnabled = current.hourlyStatsEnabled || current.hourlyWorkersEnabled;
            const enabled = newStats || newWorkers;
            await this.telegramSubscriptionsService.updateHourlyNotifications(chatId, enabled, newStats, newWorkers);

            if (!wasEnabled && enabled) {
                setTimeout(async () => {
                    await this.sendHourlyReportsForChat(chatId, newStats, newWorkers);
                }, 60 * 1000);
            }

            await this.bot.answerCallbackQuery(query.id);
            const updated = { ...current, hourlyStatsEnabled: newStats, hourlyWorkersEnabled: newWorkers } as TelegramSubscriptionsEntity;
            const { text, reply_markup } = this.buildHourlyMenu(updated, lang);
            await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup,
            });
        } catch (err) {
            console.error('[Telegram] hourly callback failed:', (err as Error).message);
            try { await this.bot.answerCallbackQuery(query.id); } catch {}
        }
    }

    private async handleBestdiffResetCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const data = query.data ?? '';
        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        if (!chatId || !messageId) return;

        const lang = this.getLanguage(chatId);
        const key = `${chatId}:${messageId}`;
        const pending = this.pendingBestdiffResets.get(key);
        this.pendingBestdiffResets.delete(key);

        try {
            if (!pending || pending.expiresAt < Date.now()) {
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? 'Anfrage abgelaufen.' : 'Request expired.',
                });
                await this.bot.editMessageText(
                    lang === 'de' ? 'Anfrage abgelaufen.' : 'Request expired.',
                    { chat_id: chatId, message_id: messageId },
                );
                return;
            }

            const trimmed = this.formatAddress(pending.address);

            if (data === 'bdr:no') {
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? 'Abgebrochen.' : 'Cancelled.',
                });
                await this.bot.editMessageText(
                    lang === 'de' ? `Reset abgebrochen — ${trimmed}` : `Reset cancelled — ${trimmed}`,
                    { chat_id: chatId, message_id: messageId },
                );
                return;
            }

            await this.stratumV1Service.resetBestDifficultyForAddress(pending.address);
            await this.stratumV2Service.resetBestDifficultyForAddress(pending.address);
            await this.addressSettingsService.updateBestDifficulty(pending.address, 0, null);
            await this.trackerService.resetTracker(pending.address);
            this.bestDiffCache.delete(pending.address);
            this.ntfyService.resetBestDiffCache(pending.address);

            await this.bot.answerCallbackQuery(query.id, {
                text: lang === 'de' ? 'Zurückgesetzt.' : 'Reset.',
            });
            await this.bot.editMessageText(
                lang === 'de'
                    ? `Best Difficulty zurückgesetzt — ${trimmed}`
                    : `Best difficulty reset — ${trimmed}`,
                { chat_id: chatId, message_id: messageId },
            );
        } catch (err) {
            console.error('[Telegram] /bestdiff_reset callback failed:', (err as Error).message);
            try {
                await this.bot.answerCallbackQuery(query.id, {
                    text: lang === 'de' ? 'Fehler beim Zurücksetzen.' : 'Reset failed.',
                });
            } catch {}
        }
    }

    private async handlePplnsStatus(chatId: number, addressParam?: string): Promise<void> {
        if (!this.pplnsService.isEnabled()) {
            await this.reply(chatId, {
                de: 'PPLNS ist auf diesem Pool nicht aktiv.',
                en: 'PPLNS is not enabled on this pool.'
            });
            return;
        }

        const address = await this.resolveAddressForChat(chatId, addressParam);
        if (!address) return;

        try {
            const [status, window, distribution, myHashrate] = await Promise.all([
                this.pplnsService.getAddressStatus(address),
                this.pplnsService.getWindowStats(),
                this.pplnsService.getCurrentDistribution(),
                this.clientService.getTotalHashrateForAddresses([address]),
            ]);

            const pplnsAddresses = distribution.map(d => d.address);
            const totalPplnsHashrate = pplnsAddresses.length > 0
                ? await this.clientService.getTotalHashrateForAddresses(pplnsAddresses)
                : 0;

            const trimmed = this.formatAddress(address);
            const percent = status.currentWindowPercent.toFixed(2);
            const myShares = this.numberSuffix.to(status.currentWindowShares);
            const totalShares = this.numberSuffix.to(window.totalShares);
            const minerCount = window.minerCount;

            const balance = status.balanceSats;
            const totalPaid = status.totalPaidSats;

            const ledgerDe = balance > 0
                ? `${this.formatSats(balance)} sats (Pool schuldet dir)`
                : balance < 0
                    ? `${this.formatSats(balance)} sats (du schuldest dem Pool — wird mit nächster Auszahlung verrechnet)`
                    : '0 sats';
            const ledgerEn = balance > 0
                ? `${this.formatSats(balance)} sats (pool owes you)`
                : balance < 0
                    ? `${this.formatSats(balance)} sats (you owe the pool — settled at the next payout)`
                    : '0 sats';

            await this.reply(chatId, {
                de: `PPLNS Status — ${trimmed}\n` +
                    `Window-Anteil: ${percent}%\n` +
                    `Deine Hashrate: ${this.formatHashrate(myHashrate)}\n` +
                    `PPLNS-Hashrate (gesamt): ${this.formatHashrate(totalPplnsHashrate)}\n` +
                    `Deine Shares: ${myShares}\n` +
                    `Pool-Shares (Window): ${totalShares}\n` +
                    `Aktive Miner im Window: ${minerCount}\n` +
                    `Saldo: ${ledgerDe}\n` +
                    `Lifetime ausbezahlt: ${this.formatSats(totalPaid)} sats`,
                en: `PPLNS status — ${trimmed}\n` +
                    `Window share: ${percent}%\n` +
                    `Your hashrate: ${this.formatHashrate(myHashrate)}\n` +
                    `PPLNS hashrate (total): ${this.formatHashrate(totalPplnsHashrate)}\n` +
                    `Your shares: ${myShares}\n` +
                    `Pool shares (window): ${totalShares}\n` +
                    `Active miners in window: ${minerCount}\n` +
                    `Ledger: ${ledgerEn}\n` +
                    `Lifetime paid: ${this.formatSats(totalPaid)} sats`,
            });
        } catch (err) {
            console.error('[Telegram] /pplns_status failed:', (err as Error).message);
            await this.reply(chatId, {
                de: 'PPLNS-Status konnte nicht geladen werden.',
                en: 'Could not load PPLNS status.'
            });
        }
    }

    private async handlePplnsTop(chatId: number): Promise<void> {
        if (!this.pplnsService.isEnabled()) {
            await this.reply(chatId, {
                de: 'PPLNS ist auf diesem Pool nicht aktiv.',
                en: 'PPLNS is not enabled on this pool.'
            });
            return;
        }

        try {
            const distribution = await this.pplnsService.getCurrentDistribution();
            if (distribution.length === 0) {
                await this.reply(chatId, {
                    de: 'Keine Shares im aktuellen PPLNS-Window.',
                    en: 'No shares in the current PPLNS window.'
                });
                return;
            }

            const top = distribution.slice(0, 10);
            const lines = top.map((entry, idx) =>
                `${(idx + 1).toString().padStart(2, ' ')}. ${this.formatAddress(entry.address)}   ${entry.percent.toFixed(2)}%`
            );

            await this.reply(chatId, {
                de: `Top 10 PPLNS-Miner (von ${distribution.length} aktiven):\n${lines.join('\n')}`,
                en: `Top 10 PPLNS miners (out of ${distribution.length} active):\n${lines.join('\n')}`,
            });
        } catch (err) {
            console.error('[Telegram] /pplns_top failed:', (err as Error).message);
            await this.reply(chatId, {
                de: 'PPLNS-Top-Liste konnte nicht geladen werden.',
                en: 'Could not load PPLNS top list.'
            });
        }
    }

    private async handleGroupStatus(chatId: number, addressParam?: string): Promise<void> {
        const address = await this.resolveAddressForChat(chatId, addressParam);
        if (!address) return;

        const entry = this.groupService.getGroupForAddress(address);
        if (!entry) {
            await this.reply(chatId, {
                de: `${this.formatAddress(address)} ist in keiner Gruppe.`,
                en: `${this.formatAddress(address)} is not in any group.`
            });
            return;
        }

        try {
            const [group, members, round, best] = await Promise.all([
                this.groupService.getGroup(entry.groupId),
                this.groupService.listMembers(entry.groupId),
                this.groupSoloService.getRoundStats(entry.groupId),
                this.groupSoloService.getRoundBestDifficulty(entry.groupId),
            ]);

            if (!group) {
                await this.reply(chatId, {
                    de: 'Gruppe nicht mehr verfügbar.',
                    en: 'Group is no longer available.'
                });
                return;
            }

            const memberAddresses = members.map(m => m.address);
            const groupHashrate = memberAddresses.length > 0
                ? await this.clientService.getTotalHashrateForAddresses(memberAddresses)
                : 0;

            const member = round.perAddress.find(p => p.address === address);
            const myShare = member ? `${member.percent.toFixed(2)}%` : '0%';
            const myShares = member ? this.numberSuffix.to(member.totalShares) : '0';
            const totalShares = this.numberSuffix.to(round.totalShares);
            const totalRejected = this.numberSuffix.to(round.totalRejected);
            const memberCount = round.perAddress.length;

            const bestDiffStr = best.bestDifficulty > 0
                ? `${this.numberSuffix.to(best.bestDifficulty)} (${this.formatAddress(best.address ?? '')})`
                : '—';

            await this.reply(chatId, {
                de: `Gruppe: ${group.name}\n` +
                    `Aktive Miner (Round): ${memberCount}\n` +
                    `Gruppen-Hashrate: ${this.formatHashrate(groupHashrate)}\n` +
                    `Dein Anteil: ${myShare} (${myShares})\n` +
                    `Round-Shares gesamt: ${totalShares}\n` +
                    `Round-Rejected: ${totalRejected}\n` +
                    `Beste Round-Difficulty: ${bestDiffStr}`,
                en: `Group: ${group.name}\n` +
                    `Active miners (round): ${memberCount}\n` +
                    `Group hashrate: ${this.formatHashrate(groupHashrate)}\n` +
                    `Your share: ${myShare} (${myShares})\n` +
                    `Round shares total: ${totalShares}\n` +
                    `Round rejected: ${totalRejected}\n` +
                    `Best round difficulty: ${bestDiffStr}`,
            });
        } catch (err) {
            console.error('[Telegram] /group_status failed:', (err as Error).message);
            await this.reply(chatId, {
                de: 'Gruppen-Status konnte nicht geladen werden.',
                en: 'Could not load group status.'
            });
        }
    }

    private async handleGroupMembers(chatId: number, addressParam?: string): Promise<void> {
        const address = await this.resolveAddressForChat(chatId, addressParam);
        if (!address) return;

        const entry = this.groupService.getGroupForAddress(address);
        if (!entry) {
            await this.reply(chatId, {
                de: `${this.formatAddress(address)} ist in keiner Gruppe.`,
                en: `${this.formatAddress(address)} is not in any group.`
            });
            return;
        }

        try {
            const [group, members, round] = await Promise.all([
                this.groupService.getGroup(entry.groupId),
                this.groupService.listMembers(entry.groupId),
                this.groupSoloService.getRoundStats(entry.groupId),
            ]);

            if (!group) {
                await this.reply(chatId, {
                    de: 'Gruppe nicht mehr verfügbar.',
                    en: 'Group is no longer available.'
                });
                return;
            }

            const shareByAddr = new Map<string, number>();
            for (const p of round.perAddress) shareByAddr.set(p.address, p.percent);

            // Sort: members with shares first (desc), then alphabetical fallback.
            const sorted = [...members].sort((a, b) => {
                const sa = shareByAddr.get(a.address) ?? -1;
                const sb = shareByAddr.get(b.address) ?? -1;
                return sb - sa;
            });

            const lines = sorted.map(m => {
                const share = shareByAddr.get(m.address);
                const shareStr = share !== undefined ? `${share.toFixed(2)}%` : '—';
                const trimmed = this.formatAddress(m.address);
                const youMarker = m.address === address ? ' (du)' : '';
                const youMarkerEn = m.address === address ? ' (you)' : '';
                return { de: `${trimmed}   ${shareStr}${youMarker}`, en: `${trimmed}   ${shareStr}${youMarkerEn}` };
            });

            await this.reply(chatId, {
                de: `Mitglieder von "${group.name}" (${members.length}):\n${lines.map(l => l.de).join('\n')}`,
                en: `Members of "${group.name}" (${members.length}):\n${lines.map(l => l.en).join('\n')}`,
            });
        } catch (err) {
            console.error('[Telegram] /group_members failed:', (err as Error).message);
            await this.reply(chatId, {
                de: 'Mitgliederliste konnte nicht geladen werden.',
                en: 'Could not load member list.'
            });
        }
    }

    private async handleGroupHistory(chatId: number, addressParam?: string): Promise<void> {
        const address = await this.resolveAddressForChat(chatId, addressParam);
        if (!address) return;

        const entry = this.groupService.getGroupForAddress(address);
        if (!entry) {
            await this.reply(chatId, {
                de: `${this.formatAddress(address)} ist in keiner Gruppe.`,
                en: `${this.formatAddress(address)} is not in any group.`
            });
            return;
        }

        try {
            const [group, history] = await Promise.all([
                this.groupService.getGroup(entry.groupId),
                this.groupSoloService.getBlockHistory(entry.groupId, 50),
            ]);

            if (!group) {
                await this.reply(chatId, {
                    de: 'Gruppe nicht mehr verfügbar.',
                    en: 'Group is no longer available.'
                });
                return;
            }

            // Filter to entries for this address; aggregate by block.
            const own = history.filter(h => h.address === address).slice(0, 10);

            if (own.length === 0) {
                await this.reply(chatId, {
                    de: `Keine Auszahlungen für ${this.formatAddress(address)} in "${group.name}".`,
                    en: `No payouts for ${this.formatAddress(address)} in "${group.name}".`
                });
                return;
            }

            const lang = this.getLanguage(chatId);
            const formatter = this.deviceNotificationFormatters[lang];

            const lines = own.map(h => {
                const when = h.createdAt ? formatter.format(new Date(h.createdAt)) : '—';
                const amount = this.formatSats(h.paidSats ?? 0);
                return `Block ${h.blockHeight} — ${when} — ${amount} sats`;
            });

            await this.reply(chatId, {
                de: `Letzte Auszahlungen für ${this.formatAddress(address)} in "${group.name}":\n${lines.join('\n')}`,
                en: `Recent payouts for ${this.formatAddress(address)} in "${group.name}":\n${lines.join('\n')}`,
            });
        } catch (err) {
            console.error('[Telegram] /group_history failed:', (err as Error).message);
            await this.reply(chatId, {
                de: 'Block-Historie konnte nicht geladen werden.',
                en: 'Could not load block history.'
            });
        }
    }
}
