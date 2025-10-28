import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { NumberSuffix } from '../utils/NumberSuffix';

export interface StatsMessages {
    de: string;
    en: string;
}

export interface WorkerOverviewData {
    workersCount: number;
    totalHashrate?: number | null;
    totalShares?: number | null;
    bestDifficulty?: number | string | null;
    workers?: Array<{
        name?: string | null;
        hashRate?: number | null;
        currentDifficulty?: number | null;
        bestDifficulty?: number | string | null;
    }> | null;
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

function parseNumeric(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function buildWorkersOverviewMessage(
    data: WorkerOverviewData,
    numberSuffix: NumberSuffix
): StatsMessages {
    const totalHashrate = parseNumeric(data.totalHashrate) ?? 0;
    const totalShares = parseNumeric(data.totalShares) ?? 0;
    const bestDifficultyTotal = parseNumeric(data.bestDifficulty);
    const bestDifficultyTotalFormatted =
        bestDifficultyTotal !== null ? numberSuffix.to(bestDifficultyTotal) : '–';

    const workerLinesDe: string[] = [];
    const workerLinesEn: string[] = [];

    (data.workers ?? []).forEach((worker, idx) => {
        const name = worker?.name?.trim() || `Worker ${idx + 1}`;
        const hashRateValue = parseNumeric(worker?.hashRate) ?? 0;
        const hashRateFormatted = numberSuffix.to(hashRateValue);
        const currentDifficultyValue = parseNumeric(worker?.currentDifficulty);
        const currentDifficultyFormatted =
            currentDifficultyValue !== null ? `${currentDifficultyValue}` : '–';
        const bestDifficultyValue = parseNumeric(worker?.bestDifficulty);
        const bestDifficultyFormatted =
            bestDifficultyValue !== null ? numberSuffix.to(bestDifficultyValue) : '–';

        workerLinesDe.push(
            `• ${name} – Hashrate: ${hashRateFormatted}, Aktuelle Difficulty: ${currentDifficultyFormatted}, Beste Difficulty: ${bestDifficultyFormatted}`
        );
        workerLinesEn.push(
            `• ${name} – Hashrate: ${hashRateFormatted}, Current difficulty: ${currentDifficultyFormatted}, Best difficulty: ${bestDifficultyFormatted}`
        );
    });

    const summaryDe = [
        '👷 Worker-Übersicht',
        `Gesamtanzahl: ${data.workersCount}`,
        `Gesamt-Hashrate: ${numberSuffix.to(totalHashrate)}`,
        `Gesamt-Shares: ${numberSuffix.to(totalShares)}`,
        `Beste Difficulty: ${bestDifficultyTotalFormatted}`,
    ].join('\n');

    const summaryEn = [
        '👷 Workers overview',
        `Total workers: ${data.workersCount}`,
        `Total hashrate: ${numberSuffix.to(totalHashrate)}`,
        `Total shares: ${numberSuffix.to(totalShares)}`,
        `Best difficulty: ${bestDifficultyTotalFormatted}`,
    ].join('\n');

    const workersDe = workerLinesDe.join('\n');
    const workersEn = workerLinesEn.join('\n');

    return {
        de: workersDe ? `${summaryDe}\n\n${workersDe}` : summaryDe,
        en: workersEn ? `${summaryEn}\n\n${workersEn}` : summaryEn,
    };
}

