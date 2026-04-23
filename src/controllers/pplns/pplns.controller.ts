import { Controller, Get, Param, Query } from '@nestjs/common';
import { PplnsService } from '../../services/pplns.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { MiningModeService } from '../../services/mining-mode.service';
import { PoolModeHashrateService } from '../../ORM/pool-mode-hashrate/pool-mode-hashrate.service';

@Controller('pplns')
export class PplnsController {

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly miningModeService: MiningModeService,
        private readonly poolModeHashrateService: PoolModeHashrateService,
    ) {}

    /**
     * GET /pplns
     * Pool-wide PPLNS info — mirrors /api/info but filtered to PPLNS participants.
     * Returns the window stats plus a `userAgents` breakdown so dashboards can
     * show which devices are currently contributing to the PPLNS pool.
     */
    @Get()
    async info() {
        const distribution = await this.pplnsService.getCurrentDistribution();
        const addresses = distribution.map(d => d.address);
        const [windowStats, userAgents] = await Promise.all([
            this.pplnsService.getWindowStats(),
            this.clientService.getUserAgentsForAddresses(addresses),
        ]);
        return {
            enabled: this.pplnsService.isEnabled(),
            ...windowStats,
            userAgents,
        };
    }

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
        return this.miningModeService.getMode(address);
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
     * GET /pplns/fees
     * Pool-side fee configuration shared by PPLNS and group-solo payout paths.
     * The UI reads this to render current fees on the groups-landing page
     * without having to re-deploy when fees change. `feePercent` is a human
     * percentage (e.g. 2 for 2%), `feeAddress` is the BTC address where the
     * pool fee output lands in the coinbase transaction.
     */
    @Get('fees')
    getFees() {
        return this.pplnsService.getFeeConfig();
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
     * GET /pplns/chart?range=1d|3d|7d
     * Historical hashrate time-series for the PPLNS payout mode — drop-in
     * compatible with `/api/info/chart` in shape.
     *
     * Backed by the `pool_mode_hashrate` table, which is incremented on
     * every accepted PPLNS-routed share. Prior implementation summed the
     * PER-ADDRESS chart data for every address currently in the window,
     * which double-counted non-PPLNS activity when a group-solo miner had
     * briefly tested PPLNS (their address stayed in the window for hours
     * while they mined group-solo, causing their current group hashrate
     * to show up as "PPLNS").
     */
    @Get('chart')
    async getChart(@Query('range') range: '1d' | '3d' | '7d' = '1d') {
        const validRange: '1d' | '3d' | '7d' =
            range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';
        return this.poolModeHashrateService.getChart('pplns', validRange);
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
