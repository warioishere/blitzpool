import { Injectable } from '@nestjs/common';

import { PplnsService } from './pplns.service';
import { GroupService } from './group.service';
import { MinerActiveModeService } from './miner-active-mode.service';

export type MiningMode = 'solo' | 'pplns' | 'group-solo';

export interface MiningModeResult {
    mode: MiningMode;
    /** Present only when mode === 'group-solo'. */
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
 *         a) PPLNS window shares → 'pplns'
 *         b) Active group membership → 'group-solo'
 *         c) Otherwise → 'solo'
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

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly groupService: GroupService,
        private readonly minerActiveModeService: MinerActiveModeService,
    ) {}

    async getMode(address: string): Promise<MiningModeResult> {
        // Primary check: live port-marker.
        const liveMode = await this.minerActiveModeService.get(address);
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
        const distribution = await this.pplnsService.getCurrentDistribution();
        if (distribution.some(d => d.address === address)) {
            return { mode: 'pplns' };
        }
        const group = this.groupService.getGroupForAddress(address);
        if (group && group.active) {
            return { mode: 'group-solo', groupId: group.groupId };
        }
        return { mode: 'solo' };
    }
}
