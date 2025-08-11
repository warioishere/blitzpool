import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { EventSource } from 'eventsource';
import { validate } from 'bitcoin-address-validation';
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
  private readonly diffNotifications: boolean;
  private bestDiffCache: Map<string, number> = new Map();
  private bestDiffOptIn: Map<string, boolean> = new Map();
  private subscribed: Set<string> = new Set();
  private eventSource?: EventSource;

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
    this.diffNotifications =
      this.configService
        .get<string>('NTFY_DIFF_NOTIFICATIONS')
        ?.toLowerCase() === 'true' || false;
  }

  async onModuleInit(): Promise<void> {
    if (!this.serverUrl) {
      return;
    }
    const [telegramAddresses, clientAddresses] = await Promise.all([
      this.telegramSubscriptionsService.getAllAddresses(),
      this.clientService.getAllAddresses(),
    ]);
    const addresses = Array.from(
      new Set([...telegramAddresses, ...clientAddresses]),
    );
    for (const addr of addresses) {
      const settings = await this.addressSettingsService.getSettings(
        addr,
        false,
      );
      this.bestDiffCache.set(addr, settings?.bestDifficulty ?? 0);
      this.subscribe(addr, false);
    }
    this.reconnect();
  }

  private topicFor(address: string): string {
    return this.topicPrefix ? `${this.topicPrefix}${address}` : address;
  }

  private reconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
    if (!this.serverUrl || this.subscribed.size === 0) {
      return;
    }
    const topics = Array.from(this.subscribed)
      .map((a) => this.topicFor(a))
      .join(',');
    const url = `${this.serverUrl}/${topics}/sse`;
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
        const topic: string | undefined = data.topic;
        if (text && topic) {
          const address = this.topicPrefix
            ? topic.replace(this.topicPrefix, '')
            : topic;
          await this.handleCommand(address, text);
        }
      } catch (err) {
        console.error('NTFY parse error', err);
      }
    };
    es.onerror = (err) => {
      console.error('NTFY connection error', err);
    };
    this.eventSource = es;
  }

  private subscribe(address: string, reconnect = true) {
    if (!this.serverUrl || this.subscribed.has(address)) {
      return;
    }
    this.subscribed.add(address);
    if (!this.bestDiffOptIn.has(address)) {
      this.bestDiffOptIn.set(address, true);
    }
    if (reconnect) {
      this.reconnect();
    }
  }

  private unsubscribe(address: string) {
    const removed = this.subscribed.delete(address);
    if (removed) {
      this.reconnect();
    }
    this.bestDiffCache.delete(address);
    this.bestDiffOptIn.delete(address);
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
    } else if (text.startsWith('/unsubscribe')) {
      const raw = text.replace('/unsubscribe', '').trim();
      const target = raw || origin;
      this.unsubscribe(target);
      await this.publish(origin, `Removed ${target}.`);
    } else if (text.startsWith('/remove')) {
      const raw = text.replace('/remove', '').trim();
      const target = raw || origin;
      this.unsubscribe(target);
      await this.publish(origin, `Removed ${target}.`);
    } else if (text.startsWith('/show_addresses')) {
      const list = Array.from(this.subscribed);
      await this.publish(
        origin,
        list.length ? list.join('\n') : 'No addresses subscribed.',
      );
    } else if (text.startsWith('/stats')) {
      const messages = await buildStatsMessage(
        origin,
        this.clientService,
        this.addressSettingsService,
        this.clientStatisticsService,
        this.numberSuffix,
      );
      if (!messages) {
        await this.publish(origin, 'No active workers found for this address.');
      } else {
        await this.publish(origin, messages.en);
      }
    } else if (text.startsWith('/poolhashrate')) {
      try {
        const apiPort = process.env.API_PORT || '3334';
        const res = await fetch(`http://localhost:${apiPort}/api/pool`);
        const data = await res.json();
        const hashrateTH = (data.totalHashRate / 1e12).toFixed(2);
        await this.publish(origin, `Current pool hashrate: ${hashrateTH} TH/s`);
      } catch (err) {
        await this.publish(origin, 'Could not fetch pool hashrate.');
        console.error('NTFY /poolhashrate error', err);
      }
    } else if (text.startsWith('/difficulty')) {
      try {
        const res = await fetch(
          'https://mempool.space/api/v1/mining/hashrate/3d',
        );
        const json = await res.json();
        const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
        await this.publish(origin, `Current difficulty: ${difficulty} T`);
      } catch (err) {
        await this.publish(origin, 'Could not fetch difficulty.');
        console.error('NTFY /difficulty error', err);
      }
    } else if (text.startsWith('/next_difficulty')) {
      try {
        const res = await fetch(
          'https://mempool.space/api/v1/difficulty-adjustment',
        );
        const data = await res.json();
        const progress = data.progressPercent.toFixed(2);
        const change = data.difficultyChange.toFixed(2);
        const estimatedDate = new Date(
          data.estimatedRetargetDate,
        ).toLocaleString('de-CH');
        const changeText = change >= 0 ? `📈 +${change}%` : `📉 ${change}%`;
        await this.publish(
          origin,
          `📊 Next difficulty adjustment:\n• Progress: ${progress}%\n• Estimated: ${estimatedDate}\n• Expected change: ${changeText}`,
        );
      } catch (err) {
        await this.publish(
          origin,
          'Could not fetch next difficulty adjustment.',
        );
        console.error('NTFY /next_difficulty error', err);
      }
    } else if (text.startsWith('/subscribe_bestdiff')) {
      const match = text.match(/\/subscribe_bestdiff\s+(on|off)/i);
      const value = match?.[1]?.toLowerCase();
      if (!value) {
        await this.publish(origin, "Please provide 'on' or 'off'.");
        return;
      }
      const enable = value === 'on';
      this.bestDiffOptIn.set(origin, enable);
      await this.publish(
        origin,
        `Best difficulty notifications ${enable ? 'enabled' : 'disabled'}.`,
      );
    } else if (text.startsWith('/start')) {
      await this.publish(
        origin,
        'Welcome to the BlitzPool notifier! Available commands:\n' +
          '/subscribe <address> - follow another address\n' +
          '/unsubscribe <address> - stop following an address\n' +
          '/stats - show worker stats\n' +
          '/poolhashrate - show current pool hashrate\n' +
          '/difficulty - show current network difficulty\n' +
          '/next_difficulty - show expected difficulty change\n' +
          '/show_addresses - list subscribed addresses',
      );
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
      Tags: 'bot',
    };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    await axios.post(url, message, { headers });
  }

  public async notify(address: string, message: string) {
    await this.publish(address, message);
  }

  public async notifySubscribersBlockFound(
    address: string,
    height: number,
    _block: any,
    message: string,
  ) {
    await this.publish(
      address,
      `Block found! Result: ${message}, Height: ${height}`,
    );
  }

  public async notifySubscribersBestDiff(
    address: string,
    submissionDifficulty: number,
  ) {
    if (!this.diffNotifications) return;

    let currentBest = this.bestDiffCache.get(address);
    if (currentBest === undefined) {
      const settings = await this.addressSettingsService.getSettings(
        address,
        false,
      );
      currentBest = settings?.bestDifficulty ?? 0;
      this.bestDiffCache.set(address, currentBest);
    }

    if (submissionDifficulty > currentBest) {
      this.bestDiffCache.set(address, submissionDifficulty);
      if (this.bestDiffOptIn.get(address) !== false) {
        await this.publish(
          address,
          `\uD83C\uDFC6 New best difficulty!\nValue: ${this.numberSuffix.to(
            submissionDifficulty,
          )}`,
        );
      }
    }
  }
}
