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
 * Derives the mining mode for a given BTC address by combining the
 * GroupService's address→group cache and the PPLNS share window membership.
 *
 * Resolution order:
 *   1. Active group membership → 'group-solo'
 *   2. Shares in the PPLNS window → 'pplns'
 *   3. Otherwise → 'solo'
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
