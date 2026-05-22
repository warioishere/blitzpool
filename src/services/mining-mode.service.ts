import { Injectable } from '@nestjs/common';

import { PplnsService } from './pplns.service';
import { GroupService } from './group.service';
import { BlockpartyService } from './blockparty.service';
import { MinerActiveModeService } from './miner-active-mode.service';

export type MiningMode = 'solo' | 'pplns' | 'group-solo' | 'blockparty';

export interface MiningModeResult {
    mode: MiningMode;
    /** Present when mode === 'group-solo' or mode === 'blockparty'. */
    groupId?: string;
}

/**
 * Derives the mining mode for a given BTC address.
 *
 * Resolution order:
 *
 *   1. Live port-marker (MinerActiveModeService) — written on every
 *      accepted share, TTL 5 min. Reflects the port the miner is
 *      ACTUALLY connecting to right now. This is the ground truth
 *      for any miner that has submitted a share in the last 5 min.
 *
 *   2. Legacy state-based detection — for addresses without a live
 *      marker (offline miner, never mined here, etc.):
 *         a) Blockparty admin address → 'blockparty' (admin treasury
 *            is the only address that triggers blockparty mining; regular
 *            blockparty members aren't mining for the party, they're
 *            passive payout recipients)
 *         b) Active group membership → 'group-solo'
 *         c) PPLNS window shares → 'pplns'
 *         d) Otherwise → 'solo'
 *
 * Why the port-marker takes precedence: PPLNS window shares can linger
 * for hours after a miner switches ports, so state-based detection lags
 * reality. The live marker catches the port-switch on the very next
 * accepted share, so UI dashboards update within the 60s poll cycle.
 *
 * Used by /api/pplns/mode/:address (dashboard routing in the UI) and by the
 * /api/client/:address/block-template endpoint (to reflect the real coinbase
 * shape the miner would produce).
 */
@Injectable()
export class MiningModeService {

    /**
     * Per-address result cache. The endpoint is uncached and polled per UI
     * dashboard load — without this, every poll did Redis GET + (on miss)
     * `pplnsService.getCurrentDistribution()` HGETALL over the PPLNS window.
     * TTL=30 s is shorter than the live-marker TTL (5 min) so a port-switch
     * still propagates within one poll cycle.
     */
    private static readonly CACHE_TTL_MS = 30_000;
    private readonly cache = new Map<string, { result: MiningModeResult; expiresAt: number }>();

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly groupService: GroupService,
        private readonly blockpartyService: BlockpartyService,
        private readonly minerActiveModeService: MinerActiveModeService,
    ) {}

    async getMode(address: string): Promise<MiningModeResult> {
        const now = Date.now();
        const cached = this.cache.get(address);
        if (cached && cached.expiresAt > now) {
            return cached.result;
        }

        const result = await this.computeMode(address);
        this.cache.set(address, { result, expiresAt: now + MiningModeService.CACHE_TTL_MS });
        return result;
    }

    /** Drop the cached entry for an address (e.g. after group membership change). */
    invalidate(address: string): void {
        this.cache.delete(address);
    }

    private async computeMode(address: string): Promise<MiningModeResult> {
        // Primary check: live port-marker.
        const liveMode = await this.minerActiveModeService.get(address);
        if (liveMode === 'blockparty') {
            const groupId = this.blockpartyService.getGroupIdForAdminAddress(address);
            if (groupId) {
                return { mode: 'blockparty', groupId };
            }
            // Marker still live but the party was dissolved meanwhile — fall through.
        }
        if (liveMode === 'pplns') {
            return { mode: 'pplns' };
        }
        if (liveMode === 'group-solo') {
            const group = this.groupService.getGroupForAddress(address);
            // Only return 'group-solo' if the group still actually exists. If the
            // group was dissolved while a marker was live, fall through to the
            // legacy detection (which will pick solo or pplns correctly).
            if (group && group.active) {
                return { mode: 'group-solo', groupId: group.groupId };
            }
        }
        if (liveMode === 'solo') {
            return { mode: 'solo' };
        }

        // Fallback: no live marker — legacy state-based detection.
        // Blockparty wins over group-solo wins over residual PPLNS-window shares:
        // both blockparty-admin and group membership are explicit opt-in actions
        // while PPLNS shares may linger in the sliding 4× network-diff window
        // from previous sessions on a PPLNS port.
        const blockpartyId = this.blockpartyService.getGroupIdForAdminAddress(address);
        if (blockpartyId) {
            return { mode: 'blockparty', groupId: blockpartyId };
        }
        const group = this.groupService.getGroupForAddress(address);
        if (group && group.active) {
            return { mode: 'group-solo', groupId: group.groupId };
        }
        const distribution = await this.pplnsService.getCurrentDistribution();
        if (distribution.some(d => d.address === address)) {
            return { mode: 'pplns' };
        }
        return { mode: 'solo' };
    }
}
