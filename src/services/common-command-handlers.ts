import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { NumberSuffix } from '../utils/NumberSuffix';

export interface StatsMessages {
    de: string;
    en: string;
}

export async function buildStatsMessage(
    address: string,
    clientService: ClientService,
    addressSettingsService: AddressSettingsService,
    clientStatisticsService: ClientStatisticsService,
    numberSuffix: NumberSuffix
): Promise<StatsMessages | null> {
    const workers = await clientService.getByAddress(address);
    if (!workers || workers.length === 0) {
        return null;
    }
    const totalHashrate = workers.reduce((sum, w) => sum + (w.hashRate ?? 0), 0);
    const totalHashrateTH = totalHashrate / 1e12;
    const lastSeenSeconds = Math.floor((Date.now() - new Date(workers[0].updatedAt).getTime()) / 1000);
    const totalShares = await clientStatisticsService.getTotalSharesForAddress(address);
    const addressSettings = await addressSettingsService.getSettings(address, false);
    const bestDiffRaw = addressSettings?.bestDifficulty ?? 0;
    const bestDifficultyG = bestDiffRaw / 1e9;

    return {
        de: `📈 Stats für deine Adresse:\n` +
            `- Aktuelle Hashrate: ${totalHashrateTH.toFixed(2)} TH/s\n` +
            `- Gesamt-Shares: ${numberSuffix.to(totalShares)}\n` +
            `- Letzter Share: vor ${lastSeenSeconds} Sekunden\n` +
            `- Beste Difficulty: ${bestDifficultyG.toFixed(2)} G`,
        en: `📈 Stats for your address:\n` +
            `- Current hashrate: ${totalHashrateTH.toFixed(2)} TH/s\n` +
            `- Total shares: ${numberSuffix.to(totalShares)}\n` +
            `- Last share: ${lastSeenSeconds} seconds ago\n` +
            `- Best difficulty: ${bestDifficultyG.toFixed(2)} G`,
    };
}

