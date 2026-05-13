import { ClientService } from '../ORM/client/client.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { NumberSuffix } from '../utils/NumberSuffix';
import type { PplnsService } from './pplns.service';
import type { GroupService } from './group.service';
import type { GroupSoloService } from './group-solo.service';

export interface StatsMessages {
    de: string;
    en: string;
}

// ── Shared formatters used by both Telegram and NTFY ──────────────────────

/** Short address rendering: `bc1q...abcde`. */
export function formatAddressShort(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-5)}`;
}

/** Hashrate as TH/s with two decimals. */
export function formatHashrateTH(hashRate: number): string {
    const th = (hashRate ?? 0) / 1e12;
    return `${th.toFixed(2)} TH/s`;
}

/** Signed sats with en-US thousand separators. */
export function formatSats(sats: number): string {
    const sign = sats < 0 ? '-' : '';
    return `${sign}${Math.abs(sats).toLocaleString('en-US')}`;
}

// ── Stateless pool-state command builders ─────────────────────────────────
// Both Telegram and NTFY surface these as bot commands; same fetch + format
// logic on either side, so it lives here once.

const POOL_API_PORT = () => process.env.API_PORT || '3334';

/** `/poolhashrate` — current total pool hashrate. */
export async function buildPoolHashrateMessage(): Promise<StatsMessages> {
    try {
        const res = await fetch(`http://localhost:${POOL_API_PORT()}/api/pool`);
        const data = await res.json();
        const hashrateTH = (data.totalHashRate / 1e12).toFixed(2);
        return {
            de: `Aktuelle Pool-Hashrate: ${hashrateTH} TH/s`,
            en: `Current pool hashrate: ${hashrateTH} TH/s`,
        };
    } catch (err) {
        console.error('[commands] /poolhashrate failed:', err);
        return {
            de: 'Konnte die Pool-Hashrate nicht abrufen.',
            en: 'Could not fetch pool hashrate.',
        };
    }
}

/** `/difficulty` — current network difficulty, in T. */
export async function buildCurrentDifficultyMessage(): Promise<StatsMessages> {
    try {
        const res = await fetch('https://mempool.space/api/v1/mining/hashrate/3d');
        const json = await res.json();
        const difficulty = (json.currentDifficulty / 1e12).toFixed(2);
        return {
            de: `Aktuelle Difficulty: ${difficulty} T`,
            en: `Current difficulty: ${difficulty} T`,
        };
    } catch (err) {
        console.error('[commands] /difficulty failed:', err);
        return {
            de: 'Konnte die Difficulty nicht abrufen.',
            en: 'Could not fetch difficulty.',
        };
    }
}

/** `/pplns_status` for a given address. Returns null if PPLNS is disabled. */
export async function buildPplnsStatusMessage(
    address: string,
    pplnsService: PplnsService,
    clientService: ClientService,
    numberSuffix: NumberSuffix,
): Promise<StatsMessages | null> {
    if (!pplnsService.isEnabled()) {
        return {
            de: 'PPLNS ist auf diesem Pool nicht aktiv.',
            en: 'PPLNS is not enabled on this pool.',
        };
    }
    try {
        const [status, window, distribution, myHashrate] = await Promise.all([
            pplnsService.getAddressStatus(address),
            pplnsService.getWindowStats(),
            pplnsService.getCurrentDistribution(),
            clientService.getTotalHashrateForAddresses([address]),
        ]);
        const pplnsAddresses = distribution.map(d => d.address);
        const totalPplnsHashrate = pplnsAddresses.length > 0
            ? await clientService.getTotalHashrateForAddresses(pplnsAddresses)
            : 0;

        const trimmed = formatAddressShort(address);
        const percent = status.currentWindowPercent.toFixed(2);
        const myShares = numberSuffix.to(status.currentWindowShares);
        const totalShares = numberSuffix.to(window.totalShares);
        const minerCount = window.minerCount;
        const balance = status.balanceSats;
        const totalPaid = status.totalPaidSats;

        const ledgerDe = balance > 0
            ? `${formatSats(balance)} sats (Pool schuldet dir)`
            : balance < 0
                ? `${formatSats(balance)} sats (du schuldest dem Pool — wird mit nächster Auszahlung verrechnet)`
                : '0 sats';
        const ledgerEn = balance > 0
            ? `${formatSats(balance)} sats (pool owes you)`
            : balance < 0
                ? `${formatSats(balance)} sats (you owe the pool — settled at the next payout)`
                : '0 sats';

        return {
            de: `PPLNS Status — ${trimmed}\n` +
                `Window-Anteil: ${percent}%\n` +
                `Deine Hashrate: ${formatHashrateTH(myHashrate)}\n` +
                `PPLNS-Hashrate (gesamt): ${formatHashrateTH(totalPplnsHashrate)}\n` +
                `Deine Shares: ${myShares}\n` +
                `Pool-Shares (Window): ${totalShares}\n` +
                `Aktive Miner im Window: ${minerCount}\n` +
                `Saldo: ${ledgerDe}\n` +
                `Lifetime ausbezahlt: ${formatSats(totalPaid)} sats`,
            en: `PPLNS status — ${trimmed}\n` +
                `Window share: ${percent}%\n` +
                `Your hashrate: ${formatHashrateTH(myHashrate)}\n` +
                `PPLNS hashrate (total): ${formatHashrateTH(totalPplnsHashrate)}\n` +
                `Your shares: ${myShares}\n` +
                `Pool shares (window): ${totalShares}\n` +
                `Active miners in window: ${minerCount}\n` +
                `Ledger: ${ledgerEn}\n` +
                `Lifetime paid: ${formatSats(totalPaid)} sats`,
        };
    } catch (err) {
        console.error('[commands] /pplns_status failed:', (err as Error).message);
        return {
            de: 'PPLNS-Status konnte nicht geladen werden.',
            en: 'Could not load PPLNS status.',
        };
    }
}

/** `/pplns_top` — top 10 miners in the current PPLNS window. */
export async function buildPplnsTopMessage(
    pplnsService: PplnsService,
): Promise<StatsMessages> {
    if (!pplnsService.isEnabled()) {
        return {
            de: 'PPLNS ist auf diesem Pool nicht aktiv.',
            en: 'PPLNS is not enabled on this pool.',
        };
    }
    try {
        const distribution = await pplnsService.getCurrentDistribution();
        if (distribution.length === 0) {
            return {
                de: 'Keine Shares im aktuellen PPLNS-Window.',
                en: 'No shares in the current PPLNS window.',
            };
        }
        const top = distribution.slice(0, 10);
        const lines = top.map((entry, idx) =>
            `${(idx + 1).toString().padStart(2, ' ')}. ${formatAddressShort(entry.address)}   ${entry.percent.toFixed(2)}%`,
        );
        return {
            de: `Top 10 PPLNS-Miner (von ${distribution.length} aktiven):\n${lines.join('\n')}`,
            en: `Top 10 PPLNS miners (out of ${distribution.length} active):\n${lines.join('\n')}`,
        };
    } catch (err) {
        console.error('[commands] /pplns_top failed:', (err as Error).message);
        return {
            de: 'PPLNS-Top-Liste konnte nicht geladen werden.',
            en: 'Could not load PPLNS top list.',
        };
    }
}

/** `/group_status` for the address's group. Returns "not in group" message if applicable. */
export async function buildGroupStatusMessage(
    address: string,
    groupService: GroupService,
    groupSoloService: GroupSoloService,
    clientService: ClientService,
    numberSuffix: NumberSuffix,
): Promise<StatsMessages> {
    const entry = groupService.getGroupForAddress(address);
    if (!entry) {
        return {
            de: `${formatAddressShort(address)} ist in keiner Gruppe.`,
            en: `${formatAddressShort(address)} is not in any group.`,
        };
    }
    try {
        const [group, members, round, best] = await Promise.all([
            groupService.getGroup(entry.groupId),
            groupService.listMembers(entry.groupId),
            groupSoloService.getRoundStats(entry.groupId),
            groupSoloService.getRoundBestDifficulty(entry.groupId),
        ]);
        if (!group) {
            return {
                de: 'Gruppe nicht mehr verfügbar.',
                en: 'Group is no longer available.',
            };
        }
        const memberAddresses = members.map(m => m.address);
        const groupHashrate = memberAddresses.length > 0
            ? await clientService.getTotalHashrateForAddresses(memberAddresses)
            : 0;
        const member = round.perAddress.find(p => p.address === address);
        const myShare = member ? `${member.percent.toFixed(2)}%` : '0%';
        const myShares = member ? numberSuffix.to(member.totalShares) : '0';
        const totalShares = numberSuffix.to(round.totalShares);
        const totalRejected = numberSuffix.to(round.totalRejected);
        const memberCount = round.perAddress.length;
        const bestDiffStr = best.bestDifficulty > 0
            ? `${numberSuffix.to(best.bestDifficulty)} (${formatAddressShort(best.address ?? '')})`
            : '—';
        return {
            de: `Gruppe: ${group.name}\n` +
                `Aktive Miner (Round): ${memberCount}\n` +
                `Gruppen-Hashrate: ${formatHashrateTH(groupHashrate)}\n` +
                `Dein Anteil: ${myShare} (${myShares})\n` +
                `Round-Shares gesamt: ${totalShares}\n` +
                `Round-Rejected: ${totalRejected}\n` +
                `Beste Round-Difficulty: ${bestDiffStr}`,
            en: `Group: ${group.name}\n` +
                `Active miners (round): ${memberCount}\n` +
                `Group hashrate: ${formatHashrateTH(groupHashrate)}\n` +
                `Your share: ${myShare} (${myShares})\n` +
                `Round shares total: ${totalShares}\n` +
                `Round rejected: ${totalRejected}\n` +
                `Best round difficulty: ${bestDiffStr}`,
        };
    } catch (err) {
        console.error('[commands] /group_status failed:', (err as Error).message);
        return {
            de: 'Gruppen-Status konnte nicht geladen werden.',
            en: 'Could not load group status.',
        };
    }
}

/** `/group_members` listing. */
export async function buildGroupMembersMessage(
    address: string,
    groupService: GroupService,
    groupSoloService: GroupSoloService,
    _numberSuffix: NumberSuffix,
): Promise<StatsMessages> {
    const entry = groupService.getGroupForAddress(address);
    if (!entry) {
        return {
            de: `${formatAddressShort(address)} ist in keiner Gruppe.`,
            en: `${formatAddressShort(address)} is not in any group.`,
        };
    }
    try {
        const [group, members, round] = await Promise.all([
            groupService.getGroup(entry.groupId),
            groupService.listMembers(entry.groupId),
            groupSoloService.getRoundStats(entry.groupId),
        ]);
        if (!group) {
            return {
                de: 'Gruppe nicht mehr verfügbar.',
                en: 'Group is no longer available.',
            };
        }
        const shareByAddr = new Map<string, number>();
        for (const p of round.perAddress) shareByAddr.set(p.address, p.percent);
        const sorted = [...members].sort((a, b) => {
            const sa = shareByAddr.get(a.address) ?? -1;
            const sb = shareByAddr.get(b.address) ?? -1;
            return sb - sa;
        });
        const lines = sorted.map(m => {
            const share = shareByAddr.get(m.address);
            const shareStr = share !== undefined ? `${share.toFixed(2)}%` : '—';
            const trimmed = formatAddressShort(m.address);
            const youMarker = m.address === address ? ' (du)' : '';
            const youMarkerEn = m.address === address ? ' (you)' : '';
            return { de: `${trimmed}   ${shareStr}${youMarker}`, en: `${trimmed}   ${shareStr}${youMarkerEn}` };
        });
        return {
            de: `Mitglieder von "${group.name}" (${members.length}):\n${lines.map(l => l.de).join('\n')}`,
            en: `Members of "${group.name}" (${members.length}):\n${lines.map(l => l.en).join('\n')}`,
        };
    } catch (err) {
        console.error('[commands] /group_members failed:', (err as Error).message);
        return {
            de: 'Mitgliederliste konnte nicht geladen werden.',
            en: 'Could not load member list.',
        };
    }
}

/** `/group_history` — recent payouts for the address in its group. */
export async function buildGroupHistoryMessage(
    address: string,
    groupService: GroupService,
    groupSoloService: GroupSoloService,
    lang: 'de' | 'en',
): Promise<StatsMessages> {
    const entry = groupService.getGroupForAddress(address);
    if (!entry) {
        return {
            de: `${formatAddressShort(address)} ist in keiner Gruppe.`,
            en: `${formatAddressShort(address)} is not in any group.`,
        };
    }
    try {
        const [group, history] = await Promise.all([
            groupService.getGroup(entry.groupId),
            groupSoloService.getBlockHistory(entry.groupId, 50),
        ]);
        if (!group) {
            return {
                de: 'Gruppe nicht mehr verfügbar.',
                en: 'Group is no longer available.',
            };
        }
        const own = history.filter(h => h.address === address).slice(0, 10);
        if (own.length === 0) {
            return {
                de: `Keine Auszahlungen für ${formatAddressShort(address)} in "${group.name}".`,
                en: `No payouts for ${formatAddressShort(address)} in "${group.name}".`,
            };
        }
        const formatter = new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-US', {
            dateStyle: 'short', timeStyle: 'short',
        });
        const lines = own.map(h => {
            const when = h.createdAt ? formatter.format(new Date(h.createdAt)) : '—';
            const amount = formatSats(h.paidSats ?? 0);
            return `Block ${h.blockHeight} — ${when} — ${amount} sats`;
        });
        return {
            de: `Letzte Auszahlungen für ${formatAddressShort(address)} in "${group.name}":\n${lines.join('\n')}`,
            en: `Recent payouts for ${formatAddressShort(address)} in "${group.name}":\n${lines.join('\n')}`,
        };
    } catch (err) {
        console.error('[commands] /group_history failed:', (err as Error).message);
        return {
            de: 'Block-Historie konnte nicht geladen werden.',
            en: 'Could not load block history.',
        };
    }
}

/** `/next_difficulty` — next-adjust estimate from mempool.space. */
export async function buildNextDifficultyMessage(): Promise<StatsMessages> {
    try {
        const res = await fetch('https://mempool.space/api/v1/difficulty-adjustment');
        const data = await res.json();
        const progress = data.progressPercent.toFixed(2);
        const change = Number(data.difficultyChange);
        const estimatedDate = new Date(data.estimatedRetargetDate).toLocaleString('de-CH');
        const changeText = change >= 0 ? `📈 +${change.toFixed(2)}%` : `📉 ${change.toFixed(2)}%`;
        return {
            de: `📊 Nächste Difficulty-Anpassung:\n\n• Fortschritt: ${progress}%\n• Geschätzt: ${estimatedDate}\n• Erwartete Änderung: ${changeText}`,
            en: `📊 Next difficulty adjustment:\n\n• Progress: ${progress}%\n• Estimated: ${estimatedDate}\n• Expected change: ${changeText}`,
        };
    } catch (err) {
        console.error('[commands] /next_difficulty failed:', err);
        return {
            de: 'Konnte die nächste Difficulty-Anpassung nicht abrufen.',
            en: 'Could not fetch next difficulty adjustment.',
        };
    }
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

function formatHashrateWithUnit(value: number, numberSuffix: NumberSuffix): string {
    const formatted = numberSuffix.to(value);
    return `${formatted}H/s`;
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
        const hashRateFormatted = formatHashrateWithUnit(hashRateValue, numberSuffix);
        const currentDifficultyValue = parseNumeric(worker?.currentDifficulty);
        const currentDifficultyFormatted =
            currentDifficultyValue !== null ? `${currentDifficultyValue}` : '–';
        const bestDifficultyValue = parseNumeric(worker?.bestDifficulty);
        const bestDifficultyFormatted =
            bestDifficultyValue !== null ? numberSuffix.to(bestDifficultyValue) : '–';

        workerLinesDe.push(
            [
                `• ${name}`,
                `Hashrate: ${hashRateFormatted}`,
                `Aktuelle Difficulty: ${currentDifficultyFormatted}`,
                `Beste Difficulty: ${bestDifficultyFormatted}`,
            ].join('\n')
        );
        workerLinesEn.push(
            [
                `• ${name}`,
                `Hashrate: ${hashRateFormatted}`,
                `Current difficulty: ${currentDifficultyFormatted}`,
                `Best difficulty: ${bestDifficultyFormatted}`,
            ].join('\n')
        );
    });

    const summaryDe = [
        '👷 Worker-Übersicht',
        `Gesamtanzahl: ${data.workersCount}`,
        `Gesamt-Hashrate: ${formatHashrateWithUnit(totalHashrate, numberSuffix)}`,
        `Gesamt-Shares: ${numberSuffix.to(totalShares)}`,
        `Beste Difficulty: ${bestDifficultyTotalFormatted}`,
    ].join('\n');

    const summaryEn = [
        '👷 Workers overview',
        `Total workers: ${data.workersCount}`,
        `Total hashrate: ${formatHashrateWithUnit(totalHashrate, numberSuffix)}`,
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

