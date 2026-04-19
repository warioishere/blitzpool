import { Controller, Get, Param, Query } from '@nestjs/common';
import { PplnsService } from '../../services/pplns.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';

@Controller('pplns')
export class PplnsController {

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly clientStatisticsService: ClientStatisticsService,
    ) {}

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
     * GET /pplns/chart?range=1d|3d|7d
     * Historical hashrate time-series for the PPLNS group — drop-in compatible
     * with `/api/info/chart`. Each data point is the sum (per 10-minute slot)
     * of per-address hashrates across every address currently in the PPLNS
     * window. Uses the same share-based hashrate formula
     * (`shares * DIFFICULTY_1 / 600`) as `/api/info/chart`.
     */
    @Get('chart')
    async getChart(@Query('range') range: '1d' | '3d' | '7d' = '1d') {
        const validRange: '1d' | '3d' | '7d' =
            range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';

        const distribution = await this.pplnsService.getCurrentDistribution();
        if (distribution.length === 0) return [];

        const perAddressSeries = await Promise.all(
            distribution.map(d => this.clientStatisticsService.getChartDataForAddress(d.address, validRange)),
        );
        const sumByLabel = new Map<string, number>();
        for (const series of perAddressSeries) {
            for (const point of series) {
                sumByLabel.set(point.label, (sumByLabel.get(point.label) ?? 0) + point.data);
            }
        }
        return Array.from(sumByLabel.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, data]) => ({ label, data }));
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
