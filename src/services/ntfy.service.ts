import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { EventSource } from 'eventsource';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import { NumberSuffix } from '../utils/NumberSuffix';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { buildStatsMessage } from './common-command-handlers';

@Injectable()
export class NtfyService implements OnModuleInit {
    private readonly serverUrl?: string;
    private readonly accessToken?: string;
    private readonly topicPrefix?: string;
    private readonly numberSuffix = new NumberSuffix();
    private sources: Map<string, EventSource> = new Map();
    private readonly diffNotifications: boolean;
    private bestDiffCache: Map<string, number> = new Map();

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly clientService: ClientService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly clientStatisticsService: ClientStatisticsService,
    ) {
        this.serverUrl = this.configService.get<string>('NTFY_SERVER_URL');
        this.accessToken = this.configService.get<string>('NTFY_ACCESS_TOKEN');
        this.topicPrefix = this.configService.get<string>('NTFY_TOPIC_PREFIX');
        this.diffNotifications = (this.configService.get<string>('NTFY_DIFF_NOTIFICATIONS')?.toLowerCase() === 'true') || false;
    }

    async onModuleInit(): Promise<void> {
        if (!this.serverUrl) {
            return;
        }
        const [telegramAddresses, clientAddresses] = await Promise.all([
            this.telegramSubscriptionsService.getAllAddresses(),
            this.clientService.getAllAddresses(),
        ]);
        const addresses = Array.from(new Set([...telegramAddresses, ...clientAddresses]));
        const bests = await Promise.all(addresses.map(a => this.addressSettingsService.getSettings(a, false)));
        addresses.forEach((addr, idx) => {
            this.bestDiffCache.set(addr, bests[idx]?.bestDifficulty ?? 0);
            this.subscribe(addr);
        });
    }

    private topicFor(address: string): string {
        return this.topicPrefix ? `${this.topicPrefix}${address}` : address;
    }

    private subscribe(address: string) {
        if (!this.serverUrl || this.sources.has(address)) {
            return;
        }
        const topic = this.topicFor(address);
        const url = `${this.serverUrl}/${topic}/sse`;
        let es: EventSource;
        if (this.accessToken) {
            const fetchWithAuth = (input: string | URL, init: any) => {
                init.headers = {
                    ...(init.headers || {}),
                    Authorization: `Bearer ${this.accessToken}`,
                };
                return fetch(input, init);
            };
            es = new EventSource(url, { fetch: fetchWithAuth } as any);
        } else {
            es = new EventSource(url);
        }
        es.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                const tags: string[] = Array.isArray(data.tags)
                    ? data.tags
                    : typeof data.tags === 'string'
                        ? data.tags.split(',')
                        : [];
                if (tags.includes('bot')) {
                    return;
                }
                const text: string | undefined = data.message?.trim();
                if (text) {
                    await this.handleCommand(address, text);
                }
            } catch (err) {
                console.error('NTFY parse error', err);
            }
        };
        es.onerror = (err) => {
            console.error('NTFY connection error', err);
        };
        this.sources.set(address, es);
    }

    private async handleCommand(origin: string, text: string) {
        if (text.startsWith('/subscribe')) {
            const raw = text.replace('/subscribe', '').trim();
            if (!raw) {
                await this.publish(origin, 'Please provide an address.');
                return;
            }
            const address = raw;
            if (!validate(address)) {
                await this.publish(origin, 'Invalid address.');
                return;
            }
            this.subscribe(address);
            await this.publish(origin, `Subscribed to ${address}.`);
        } else if (text.startsWith('/stats')) {
            const messages = await buildStatsMessage(
                origin,
                this.clientService,
                this.addressSettingsService,
                this.clientStatisticsService,
                this.numberSuffix
            );
            if (!messages) {
                await this.publish(origin, 'No active workers found for this address.');
            } else {
                await this.publish(origin, messages.en);
            }
        } else {
            await this.publish(origin, 'Unknown command.');
        }
    }

    private async publish(address: string, message: string) {
        if (!this.serverUrl) {
            return;
        }
        const topic = this.topicFor(address);
        const url = `${this.serverUrl}/${topic}`;
        const headers: Record<string, string> = {
            'Content-Type': 'text/plain',
            'Tags': 'bot',
        };
        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        await axios.post(url, message, { headers });
    }

    public async notify(address: string, message: string) {
        await this.publish(address, message);
    }

    public async notifySubscribersBlockFound(address: string, height: number, _block: any, message: string) {
        await this.publish(address, `Block found! Result: ${message}, Height: ${height}`);
    }

    public async notifySubscribersBestDiff(address: string, submissionDifficulty: number) {
        if (!this.diffNotifications) return;

        let currentBest = this.bestDiffCache.get(address);
        if (currentBest === undefined) {
            const settings = await this.addressSettingsService.getSettings(address, false);
            currentBest = settings?.bestDifficulty ?? 0;
            this.bestDiffCache.set(address, currentBest);
        }

        if (submissionDifficulty > currentBest) {
            this.bestDiffCache.set(address, submissionDifficulty);
            await this.publish(address, `\uD83C\uDFC6 New best difficulty!\nValue: ${this.numberSuffix.to(submissionDifficulty)}`);
        }
    }
}

