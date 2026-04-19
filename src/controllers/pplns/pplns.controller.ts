import { Controller, Get, Param, Query } from '@nestjs/common';
import { PplnsService } from '../../services/pplns.service';
import { GroupService } from '../../services/group.service';

@Controller('pplns')
export class PplnsController {

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly groupService: GroupService,
    ) {}

    /**
     * GET /pplns/mode/:address
     * Returns the mining mode the given BTC address is currently operating in.
     *   - 'group-solo' if the address is in an active group
     *   - 'pplns' otherwise, if the address has shares in the PPLNS window
     *   - 'solo' otherwise
     * The UI uses this for mode-aware dashboard rendering (hiding solo-only
     * widgets, showing PPLNS/group panels).
     */
    @Get('mode/:address')
    async getMiningMode(@Param('address') address: string) {
        const group = this.groupService.getGroupForAddress(address);
        if (group && group.active) {
            return { mode: 'group-solo', groupId: group.groupId };
        }
        const distribution = await this.pplnsService.getCurrentDistribution();
        const inPplns = distribution.some(d => d.address === address);
        if (inPplns) {
            return { mode: 'pplns' };
        }
        return { mode: 'solo' };
    }

    /**
     * GET /pplns/status
     * Pool-wide PPLNS status: window stats, miner count, fee config.
     */
    @Get('status')
    async getStatus() {
        const windowStats = await this.pplnsService.getWindowStats();
        return {
            enabled: this.pplnsService.isEnabled(),
            ...windowStats,
        };
    }

    /**
     * GET /pplns/distribution
     * Current share distribution across all miners in the PPLNS window.
     */
    @Get('distribution')
    async getDistribution() {
        return this.pplnsService.getCurrentDistribution();
    }

    /**
     * GET /pplns/:address
     * PPLNS status for a specific miner address.
     */
    @Get(':address')
    async getAddressStatus(@Param('address') address: string) {
        return this.pplnsService.getAddressStatus(address);
    }

    /**
     * GET /pplns/:address/history?limit=50
     * Payout history for a specific miner address.
     */
    @Get(':address/history')
    async getPayoutHistory(
        @Param('address') address: string,
        @Query('limit') limitStr?: string,
    ) {
        const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200);
        return this.pplnsService.getPayoutHistory(address, limit);
    }
}
