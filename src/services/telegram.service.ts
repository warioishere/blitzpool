import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';
import { NumberSuffix } from '../utils/NumberSuffix';
import { decryptMessageIfNeeded } from '../utils/message-decryptor';

import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';

@Injectable()
export class TelegramService implements OnModuleInit {

    private bot: TelegramBot;
    private diffNotifications: boolean;
    private numberSuffix: NumberSuffix;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService
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

        this.bot.onText(/\/subscribe/, async (msg) => {
            const address = msg.text.split('/subscribe ')[1];
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

        this.bot.onText(/\/start/, (msg) => {
            this.bot.sendMessage(msg.chat.id,
`Willkommen beim BlitzPool Status Bot! 💡

Du kannst mir:
– direkt schreiben (z. B. /subscribe 1BitcoinAdresse)
– oder verschlüsselt senden (z. B. über ein Tool)

🔐 Wenn du mir vertrauliche Infos schicken willst:
1. Lesst euch die README durch: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/blob/master/README.md
2a. Ladet den python Script für Linux und Mac herrunter: https://cloud.yourdevice.ch/s/TbqdwE24jTRmtRp
2b. Oder für Windows: https://github.com/warioishere/blitzpool-message-encryptor-for-TG/releases/tag/v1.0.0
3a. Führt den Script auf Windows/Mac im Terminal aus mit ./blitzpool-message-encryptor.py
3b. Oder auf Windows mit dem Doppelklick auf die exe
4. Gebt den subscribe Textbefehl ein, z.B: /subscribe bc1qxxxx
3. Sende den erzeugten verschlüsselten Text direkt an mich.

Ich entschlüssle ihn und reagiere genau wie bei Klartext. 🔒`
            );
        });

        this.bot.on('message', async (msg) => {
            if (!msg.text) return;

            let text = msg.text.trim();
            const decrypted = decryptMessageIfNeeded(text);

            if (decrypted) {
                text = decrypted;
            }

            if (text.startsWith('/subscribe ')) {
                const address = text.split('/subscribe ')[1];
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
            } else {
                console.log("Unverarbeitete Nachricht:", text);
            }
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

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const subscriberMessages = subscribers.map(subscriber => {
            return this.bot.sendMessage(subscriber.telegramChatId, `Neue beste Diff! Ergebnis: ${this.numberSuffix.to(submissionDifficulty)}`);
        });

        Promise.all(subscriberMessages).then();
    }

}
