import { Injectable } from '@nestjs/common';

import { PplnsService } from './pplns.service';
import { GroupService } from './group.service';

export type MiningMode = 'solo' | 'pplns' | 'group-solo';

export interface MiningModeResult {
    mode: MiningMode;
    /** Present only when mode === 'group-solo'. */
    groupId?: string;
}

/**
 * Derives the mining mode for a given BTC address by combining PPLNS
 * window membership and the GroupService's address→group cache.
 *
 * Resolution order — PPLNS before group, consistent with the pool's
 * share-routing priority (see StratumV1Client / StratumV2Client): an
 * explicit connection to the PPLNS port overrides group membership,
 * because PPLNS-window shares only exist when a miner actually chose
 * to connect on that port. Checking group first would hide active
 * PPLNS mining from the UI whenever the address happens to be in a
 * group, which is exactly the bug the routing flip fixed.
 *
 *   1. Shares in the PPLNS window → 'pplns'
 *   2. Active group membership    → 'group-solo'
 *   3. Otherwise                  → 'solo'
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
    ) {}

    async getMode(address: string): Promise<MiningModeResult> {
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
