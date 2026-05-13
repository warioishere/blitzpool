import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { EventSource } from 'eventsource';
import { validate } from 'bitcoin-address-validation';
import { NumberSuffix } from '../utils/NumberSuffix';
import { NtfySubscriptionsService } from '../ORM/ntfy-subscriptions/ntfy-subscriptions.service';
import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { BestDifficultyTrackerService } from '../ORM/best-difficulty-tracker/best-difficulty-tracker.service';
import { StratumV1Service } from './stratum-v1.service';
import { StratumV2Service } from './stratum-v2.service';
import { buildStatsMessage, buildWorkersOverviewMessage } from './common-command-handlers';

@Injectable()
export class NtfyService implements OnModuleInit {
  private readonly serverUrl?: string;
  private readonly accessToken?: string;
  private readonly topicPrefix?: string;
  private readonly numberSuffix = new NumberSuffix();
  private diffNotifications = false;
  private bestDiffCache: Map<string, number> = new Map();
  private bestDiffOptIn: Map<string, boolean> = new Map();
  private subscribed: Set<string> = new Set();
  private eventSource?: EventSource;
  private retryTimer?: NodeJS.Timeout;
  private readonly shouldInitialize: boolean;
  private readonly deviceNotificationFormatters: Record<'de' | 'en', Intl.DateTimeFormat>;

  constructor(
    private readonly configService: ConfigService,
    private readonly ntfySubscriptionsService: NtfySubscriptionsService,
    private readonly clientService: ClientService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly trackerService: BestDifficultyTrackerService,
    @Inject(forwardRef(() => StratumV1Service))
    private readonly stratumV1Service: StratumV1Service,
    @Inject(forwardRef(() => StratumV2Service))
    private readonly stratumV2Service: StratumV2Service,
  ) {
    this.shouldInitialize = true;

    // Initialize timezone formatters
    const timezonePreference = this.configService.get<string>('NTFY_TIMEZONE')?.trim();
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

    this.serverUrl = this.configService.get<string>('NTFY_SERVER_URL');
    this.accessToken = this.configService.get<string>('NTFY_ACCESS_TOKEN');
    this.topicPrefix = this.configService.get<string>('NTFY_TOPIC_PREFIX');
    this.diffNotifications =
      this.configService
        .get<string>('NTFY_DIFF_NOTIFICATIONS')
        ?.toLowerCase() === 'true' || false;
  }

  private formatAddress(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-5)}`;
  }

  private async getLanguage(origin: string): Promise<'de' | 'en'> {
    return await this.ntfySubscriptionsService.getLanguage(origin);
  }

  private async reply(origin: string, messages: { de: string; en: string }) {
    const lang = await this.getLanguage(origin);
    await this.publish(origin, messages[lang]);
  }

  private async sendHourlyReportsForAddress(address: string, showStats: boolean, showWorkers: boolean): Promise<void> {
    try {
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
            const lang = await this.getLanguage(address);
            await this.publish(address, messages[lang]);
          }
        } catch (err) {
          console.error(`NTFY: Error sending initial stats for ${address}:`, err);
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
              const lang = await this.getLanguage(address);
              await this.publish(address, messages[lang]);
            }
          }
        } catch (err) {
          console.error(`NTFY: Error sending initial workers for ${address}:`, err);
        }
      }
    } catch (err) {
      console.error(`NTFY: Error sending hourly reports for ${address}:`, err);
    }
  }

  private async resolveAddressForChat(origin: string, addressParam?: string): Promise<string | null> {
    let raw = addressParam?.trim();

    if (raw) {
      if (!validate(raw)) {
        await this.reply(origin, {
          de: 'Ungültige Adresse.',
          en: 'Invalid address.'
        });
        return null;
      }
      return raw;
    }

    // For NTFY, the origin IS the address (topic-based)
    // We don't have a subscription database like Telegram
    if (validate(origin)) {
      return origin;
    }

    await this.reply(origin, {
      de: 'Bitte gib eine Adresse an.',
      en: 'Please provide an address.'
    });
    return null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.shouldInitialize || !this.serverUrl) {
      return;
    }
    const clientAddresses = await this.clientService.getAllAddresses();
    const addresses = Array.from(new Set(clientAddresses));
    if (addresses.length > 0) {
      // Single IN-list read instead of N sequential getSettings round-trips.
      const diffs = await this.addressSettingsService.getBestDifficultiesForAddresses(addresses);
      for (const addr of addresses) {
        this.bestDiffCache.set(addr, diffs.get(addr) ?? 0);
        this.subscribe(addr, false);
      }
    }
    this.reconnect();
  }

  private topicFor(address: string): string {
    return this.topicPrefix ? `${this.topicPrefix}${address}` : address;
  }

  private reconnect() {
    if (!this.shouldInitialize) {
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
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
    es.onerror = (err: any) => {
      if (err?.status === 429) {
        this.retryTimer = setTimeout(() => this.reconnect(), 10_000);
        return;
      }
      // Connection errors are expected (network interruptions), silently retry
      // Uncomment for debugging: console.error('NTFY connection error', err);
    };
    this.eventSource = es;
  }

  private subscribe(address: string, reconnect = true) {
    if (!this.shouldInitialize || !this.serverUrl || this.subscribed.has(address)) {
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
    this.resetBestDiffCache(address);
  }

  public resetBestDiffCache(address: string) {
    this.bestDiffCache.delete(address);
    this.bestDiffOptIn.delete(address);
  }

  private async handleCommand(origin: string, text: string) {
    if (text.startsWith('/deutsch')) {
      await this.ntfySubscriptionsService.updateLanguage(origin, 'de');
      await this.reply(origin, {
        de: 'Sprache auf Deutsch gestellt.',
        en: 'Language switched to German.'
      });
    } else if (text.startsWith('/english')) {
      await this.ntfySubscriptionsService.updateLanguage(origin, 'en');
      await this.reply(origin, {
        de: 'Sprache auf Englisch gestellt.',
        en: 'Language switched to English.'
      });
    } else if (text.startsWith('/subscribe')) {
      const raw = text.replace('/subscribe', '').trim();
      if (!raw) {
        await this.reply(origin, {
          de: 'Bitte gib eine Adresse an.',
          en: 'Please provide an address.'
        });
        return;
      }
      const address = raw;
      if (!validate(address)) {
        await this.reply(origin, {
          de: 'Ungültige Adresse.',
          en: 'Invalid address.'
        });
        return;
      }
      this.subscribe(address);
      await this.reply(origin, {
        de: `Benachrichtigung für ${address} aktiviert.`,
        en: `Subscribed to ${address}.`
      });
    } else if (text.startsWith('/unsubscribe')) {
      const raw = text.replace('/unsubscribe', '').trim();
      const target = raw || origin;
      this.unsubscribe(target);
      await this.reply(origin, {
        de: `${target} entfernt.`,
        en: `Removed ${target}.`
      });
    } else if (text.startsWith('/remove')) {
      const raw = text.replace('/remove', '').trim();
      if (!raw) {
        await this.reply(origin, {
          de: 'Bitte gib eine Adresse an.',
          en: 'Please provide an address.'
        });
        return;
      }
      const target = raw;
      if (!validate(target)) {
        await this.reply(origin, {
          de: 'Ungültige Adresse.',
          en: 'Invalid address.'
        });
        return;
      }
      this.unsubscribe(target);
      await this.reply(origin, {
        de: 'Adresse entfernt.',
        en: 'Address removed.'
      });
    } else if (text.startsWith('/show_addresses')) {
      const list = Array.from(this.subscribed);
      await this.reply(origin, {
        de: list.length ? `Abonnierte Adressen:\n${list.join('\n')}` : 'Keine Adressen abonniert.',
        en: list.length ? `Subscribed addresses:\n${list.join('\n')}` : 'No addresses subscribed.'
      });
    } else if (text.startsWith('/stats')) {
      const messages = await buildStatsMessage(
        origin,
        this.clientService,
        this.addressSettingsService,
        this.clientStatisticsService,
        this.numberSuffix,
      );
      if (!messages) {
        await this.reply(origin, {
          de: 'Keine aktiven Worker für diese Adresse gefunden.',
          en: 'No active workers found for this address.'
        });
      } else {
        await this.reply(origin, messages);
      }
    } else if (text.startsWith('/show_workers')) {
      const raw = text.replace('/show_workers', '').trim();
      const address = raw || origin;

      if (!validate(address)) {
        await this.reply(origin, {
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
          await this.reply(origin, {
            de: 'Konnte Worker-Daten nicht abrufen.',
            en: 'Could not fetch worker data.'
          });
          return;
        }
        const payload = await res.json();
        if (!payload || !Array.isArray(payload.workers) || payload.workers.length === 0) {
          await this.reply(origin, {
            de: 'Keine Worker für diese Adresse gefunden.',
            en: 'No workers found for this address.'
          });
          return;
        }

        const messages = buildWorkersOverviewMessage(payload, this.numberSuffix);
        await this.reply(origin, messages);
      } catch (err) {
        console.error('NTFY /show_workers error:', err);
        await this.reply(origin, {
          de: 'Fehler beim Abrufen der Worker-Daten.',
          en: 'Failed to retrieve worker data.'
        });
      }
    } else if (text.startsWith('/poolhashrate')) {
      try {
        const apiPort = process.env.API_PORT || '3334';
        const res = await fetch(`http://localhost:${apiPort}/api/pool`);
        const data = await res.json();
        const hashrateTH = (data.totalHashRate / 1e12).toFixed(2);
        await this.reply(origin, {
          de: `Aktuelle Pool-Hashrate: ${hashrateTH} TH/s`,
          en: `Current pool hashrate: ${hashrateTH} TH/s`
        });
      } catch (err) {
        await this.reply(origin, {
          de: 'Konnte die Pool-Hashrate nicht abrufen.',
          en: 'Could not fetch pool hashrate.'
        });
        console.error('NTFY /poolhashrate error', err);
      }
    } else if (text.startsWith('/difficulty')) {
      try {
        const res = await fetch(
          'https://mempool.space/api/v1/mining/hashrate/3d',
        );
        const json = await res.json();
        const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
        await this.reply(origin, {
          de: `Aktuelle Difficulty: ${difficulty} T`,
          en: `Current difficulty: ${difficulty} T`
        });
      } catch (err) {
        await this.reply(origin, {
          de: 'Konnte die Difficulty nicht abrufen.',
          en: 'Could not fetch difficulty.'
        });
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
        await this.reply(origin, {
          de: `📊 Nächste Difficulty-Anpassung:\n\n• Fortschritt: ${progress}%\n• Geschätzt: ${estimatedDate}\n• Erwartete Änderung: ${changeText}`,
          en: `📊 Next difficulty adjustment:\n\n• Progress: ${progress}%\n• Estimated: ${estimatedDate}\n• Expected change: ${changeText}`
        });
      } catch (err) {
        await this.reply(origin, {
          de: 'Konnte die nächste Difficulty-Anpassung nicht abrufen.',
          en: 'Could not fetch next difficulty adjustment.'
        });
        console.error('NTFY /next_difficulty error', err);
      }
    } else if (text.startsWith('/subscribe_bestdiff')) {
      const match = text.match(/\/subscribe_bestdiff\s+(on|off)/i);
      const value = match?.[1]?.toLowerCase();
      if (!value) {
        await this.reply(origin, {
          de: "Bitte gib 'on' oder 'off' an.",
          en: "Please provide 'on' or 'off'."
        });
        return;
      }
      const enable = value === 'on';
      this.bestDiffOptIn.set(origin, enable);
      await this.reply(origin, {
        de: `Best Difficulty Benachrichtigungen ${enable ? 'aktiviert' : 'deaktiviert'}.`,
        en: `Best difficulty notifications ${enable ? 'enabled' : 'disabled'}.`
      });
    } else if (text.startsWith('/bestdiff_reset')) {
      const raw = text.replace('/bestdiff_reset', '').trim();
      const address = await this.resolveAddressForChat(origin, raw);
      if (!address) {
        return;
      }

      try {
        // Reset via stratum services (handles DB, cache, workers, and broadcast)
        await this.stratumV1Service.resetBestDifficultyForAddress(address);
        await this.stratumV2Service.resetBestDifficultyForAddress(address);

        // Clear local notification service caches
        await this.addressSettingsService.updateBestDifficulty(address, 0, null);
        await this.trackerService.resetTracker(address);
        this.bestDiffCache.delete(address);

        await this.reply(origin, {
          de: `Best Difficulty für ${this.formatAddress(address)} zurückgesetzt.`,
          en: `Best difficulty for ${this.formatAddress(address)} reset.`
        });
      } catch (error) {
        console.error('NTFY /bestdiff_reset error:', error);
        await this.reply(origin, {
          de: 'Fehler beim Zurücksetzen der Best Difficulty. Bitte später erneut versuchen.',
          en: 'Failed to reset best difficulty. Please try again later.'
        });
      }
    } else if (text.startsWith('/device_notifications')) {
      const match = text.match(/\/device_notifications\s+(on|off)/i);
      const action = match?.[1]?.toLowerCase();

      if (!action || !['on', 'off'].includes(action)) {
        await this.reply(origin, {
          de: "Bitte gib 'on' oder 'off' an.",
          en: "Please provide 'on' or 'off'."
        });
        return;
      }

      const enabled = action === 'on';

      try {
        await this.ntfySubscriptionsService.updateDeviceNotifications(origin, enabled);
        await this.reply(origin, {
          de: `Geräte-Benachrichtigungen ${enabled ? 'aktiviert' : 'deaktiviert'}.`,
          en: `Device notifications ${enabled ? 'enabled' : 'disabled'}.`
        });
      } catch (error) {
        console.error('NTFY /device_notifications error:', error);
        await this.reply(origin, {
          de: 'Fehler beim Setzen der Einstellung. Bitte später erneut versuchen.',
          en: 'Failed to update setting. Please try again later.'
        });
      }
    } else if (text.startsWith('/send_hourly')) {
      const match = text.match(/^\/send_hourly\s+(on|off)(?:\s+(show_workers|show_stats))?(?:\s+(show_workers|show_stats))?/i);
      const action = match?.[1]?.toLowerCase();
      const arg1 = match?.[2]?.toLowerCase();
      const arg2 = match?.[3]?.toLowerCase();

      if (!action || !['on', 'off'].includes(action)) {
        await this.reply(origin, {
          de: "Bitte gib 'on' oder 'off' an.\nVerwendung: /send_hourly on show_workers show_stats",
          en: "Please provide 'on' or 'off'.\nUsage: /send_hourly on show_workers show_stats"
        });
        return;
      }

      const enabled = action === 'on';

      if (enabled) {
        const features = [arg1, arg2].filter(f => f);
        const validFeatures = new Set(['show_workers', 'show_stats']);
        const hasValidFeature = features.some(f => validFeatures.has(f));

        if (features.length === 0 || !hasValidFeature) {
          await this.reply(origin, {
            de: "Bitte gib mindestens 'show_workers' oder 'show_stats' an.\nVerwendung: /send_hourly on show_workers show_stats",
            en: "Please provide at least 'show_workers' or 'show_stats'.\nUsage: /send_hourly on show_workers show_stats"
          });
          return;
        }

        const showWorkers = features.includes('show_workers');
        const showStats = features.includes('show_stats');

        try {
          await this.ntfySubscriptionsService.updateHourlyNotifications(origin, true, showStats, showWorkers);

          // Send first report immediately (after 1 minute)
          setTimeout(async () => {
            await this.sendHourlyReportsForAddress(origin, showStats, showWorkers);
          }, 60 * 1000);

          const featureList = [showWorkers ? 'show_workers' : null, showStats ? 'show_stats' : null].filter(Boolean).join(' + ');
          await this.reply(origin, {
            de: `Stündliche Benachrichtigungen aktiviert für: ${featureList}`,
            en: `Hourly notifications enabled for: ${featureList}`
          });
        } catch (error) {
          console.error('NTFY /send_hourly error:', error);
          await this.reply(origin, {
            de: 'Fehler beim Aktivieren der stündlichen Benachrichtigungen. Bitte später erneut versuchen.',
            en: 'Failed to enable hourly notifications. Please try again later.'
          });
        }
      } else {
        try {
          await this.ntfySubscriptionsService.updateHourlyNotifications(origin, false, false, false);
          await this.reply(origin, {
            de: 'Stündliche Benachrichtigungen deaktiviert.',
            en: 'Hourly notifications disabled.'
          });
        } catch (error) {
          console.error('NTFY /send_hourly error:', error);
          await this.reply(origin, {
            de: 'Fehler beim Deaktivieren der stündlichen Benachrichtigungen. Bitte später erneut versuchen.',
            en: 'Failed to disable hourly notifications. Please try again later.'
          });
        }
      }
    } else if (text.startsWith('/start')) {
      await this.reply(origin, {
        de: 'Willkommen beim BlitzPool Benachrichtigungsdienst! Verfügbare Befehle:\n\n' +
          '/subscribe <adresse> - Weitere Adresse folgen\n' +
          '/unsubscribe <adresse> - Adresse nicht mehr folgen\n' +
          '/remove <adresse> - Adresse entfernen\n' +
          '/stats - Worker-Statistiken anzeigen\n' +
          '/show_workers - Worker-Übersicht anzeigen\n' +
          '/poolhashrate - Aktuelle Pool-Hashrate anzeigen\n' +
          '/difficulty - Aktuelle Netzwerk-Difficulty anzeigen\n' +
          '/next_difficulty - Erwartete Difficulty-Änderung anzeigen\n' +
          '/subscribe_bestdiff on|off - Best-Diff Benachrichtigungen\n' +
          '/bestdiff_reset - Best-Diff zurücksetzen\n' +
          '/device_notifications on|off - Geräte-Benachrichtigungen\n' +
          '/send_hourly on|off - Stündliche Updates\n' +
          '/show_addresses - Abonnierte Adressen auflisten\n' +
          '/deutsch - Auf Deutsch umstellen\n' +
          '/english - Switch to English',
        en: 'Welcome to the BlitzPool notifier! Available commands:\n\n' +
          '/subscribe <address> - Follow another address\n' +
          '/unsubscribe <address> - Stop following an address\n' +
          '/remove <address> - Remove address\n' +
          '/stats - Show worker stats\n' +
          '/show_workers - Show worker overview\n' +
          '/poolhashrate - Show current pool hashrate\n' +
          '/difficulty - Show current network difficulty\n' +
          '/next_difficulty - Show expected difficulty change\n' +
          '/subscribe_bestdiff on|off - Best-diff notifications\n' +
          '/bestdiff_reset - Reset best-diff counter\n' +
          '/device_notifications on|off - Device notifications\n' +
          '/send_hourly on|off - Hourly updates\n' +
          '/show_addresses - List subscribed addresses\n' +
          '/deutsch - Auf Deutsch umstellen\n' +
          '/english - Switch to English'
      });
    } else {
      await this.reply(origin, {
        de: 'Unbekannter Befehl. Nutze /start für eine Liste der Befehle.',
        en: 'Unknown command. Use /start for a list of commands.'
      });
    }
  }

  private async publish(address: string, message: string) {
    if (!this.shouldInitialize || !this.serverUrl) {
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
    try {
      await axios.post(url, message, { headers, timeout: 10000 });
    } catch (error) {
      console.error(`[Ntfy] Failed to publish to ${address}:`, error.message);
    }
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

    const settings = await this.addressSettingsService.getSettings(
      address,
      false,
    );
    const persistedBest = settings?.bestDifficulty ?? 0;

    this.bestDiffCache.set(address, persistedBest);

    if (submissionDifficulty > persistedBest) {
      this.bestDiffCache.set(address, submissionDifficulty);
      if (this.bestDiffOptIn.get(address) !== false) {
        const lang = await this.getLanguage(address);
        const message = lang === 'de'
          ? `🏆 Neue beste Difficulty!\nWert: ${this.numberSuffix.to(submissionDifficulty)}`
          : `🏆 New best difficulty!\nValue: ${this.numberSuffix.to(submissionDifficulty)}`;
        await this.publish(address, message);
      }
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
    if (!this.shouldInitialize || !this.serverUrl) return;

    const { address, workerName, userAgent, isOnline, timestamp, isReturning } = params;

    const eventTime = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const lang = await this.getLanguage(address);
    const timeFormatted = this.deviceNotificationFormatters[lang].format(eventTime);
    const trimmedAgent = userAgent?.trim();
    const trimmedWorker = workerName?.trim();

    const userAgentDe = trimmedAgent && trimmedAgent.length > 0 ? trimmedAgent : 'unbekannt';
    const userAgentEn = trimmedAgent && trimmedAgent.length > 0 ? trimmedAgent : 'unknown';
    const workerDe = trimmedWorker && trimmedWorker.length > 0 ? trimmedWorker : 'unbekannt';
    const workerEn = trimmedWorker && trimmedWorker.length > 0 ? trimmedWorker : 'unknown';

    const messageDe = isOnline
      ? `📶 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeFormatted} ${isReturning ? 'wieder ' : ''}online.`
      : `📴 Gerät ${userAgentDe} (Worker ${workerDe}) ist seit ${timeFormatted} offline.`;
    const messageEn = isOnline
      ? `📶 Device with ${userAgentEn} (worker ${workerEn}) ${isReturning ? 'back ' : ''}online at ${timeFormatted}.`
      : `📴 Device with ${userAgentEn} (worker ${workerEn}) went offline at ${timeFormatted}.`;

    const message = lang === 'de' ? messageDe : messageEn;
    await this.publish(address, message);
  }

  @Interval(60 * 60 * 1000) // Run every hour
  private async sendHourlyUpdates(): Promise<void> {
    if (!this.shouldInitialize || !this.serverUrl) return;

    try {
      const enabledSubscriptions = await this.ntfySubscriptionsService.getHourlyEnabledAddresses();
      // Sequential await + per-subscriber HTTP loopback used to block the
      // whole cron tick behind one slow miner. Parallel fan-out lets the
      // hourly burst finish in roughly the time of the single slowest send.
      await Promise.all(enabledSubscriptions.map(sub => this.sendHourlyForOne(sub)));
    } catch (err) {
      console.error('NTFY: Fehler beim Ausführen der Stundlich-Benachrichtigungen:', err);
    }
  }

  private async sendHourlyForOne(sub: { address: string; hourlyStatsEnabled: boolean; hourlyWorkersEnabled: boolean }): Promise<void> {
    const address = sub.address;
    try {
      if (sub.hourlyStatsEnabled) {
        try {
          const messages = await buildStatsMessage(
            address,
            this.clientService,
            this.addressSettingsService,
            this.clientStatisticsService,
            this.numberSuffix
          );
          if (messages) {
            const lang = await this.getLanguage(address);
            await this.publish(address, messages[lang]);
          }
        } catch (err) {
          console.error(`NTFY: Fehler beim Senden von Stats für ${address}:`, err);
        }
      }

      if (sub.hourlyWorkersEnabled) {
        try {
          const apiPort = process.env.API_PORT ?? '3334';
          const url = `http://localhost:${apiPort}/api/client/${encodeURIComponent(address)}`;
          const res = await fetch(url);
          if (res.ok) {
            const payload = await res.json();
            if (payload && Array.isArray(payload.workers) && payload.workers.length > 0) {
              const messages = buildWorkersOverviewMessage(payload, this.numberSuffix);
              const lang = await this.getLanguage(address);
              await this.publish(address, messages[lang]);
            }
          }
        } catch (err) {
          console.error(`NTFY: Fehler beim Senden von Workers für ${address}:`, err);
        }
      }
    } catch (err) {
      console.error(`NTFY: Fehler beim Verarbeiten von Stundlich-Updates für ${address}:`, err);
    }
  }
}
