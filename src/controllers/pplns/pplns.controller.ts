import { Controller, Get, Param, Query } from '@nestjs/common';
import { PplnsService } from '../../services/pplns.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { MiningModeService } from '../../services/mining-mode.service';
import { PoolModeHashrateService } from '../../ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import { DustSweepService } from '../../services/dust-sweep.service';
import {
    DUST_LIMIT_SATS,
    COINBASE_BASE_WEIGHT,
    COINBASE_OUTPUT_WEIGHT,
    COINBASE_WITNESS_COMMITMENT_WEIGHT,
} from '../../services/coinbase-distribution';

@Controller('pplns')
export class PplnsController {

    constructor(
        private readonly pplnsService: PplnsService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly miningModeService: MiningModeService,
        private readonly poolModeHashrateService: PoolModeHashrateService,
        private readonly dustSweepService: DustSweepService,
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
     * Pool-side fee + coinbase-shape + PPLNS-port gate configuration.
     * The UI reads this to render fees on the groups-landing page and
     * the PPLNS Info / mining-modes page without re-deploying when
     * values change.
     *
     *   - feePercent: human percent (e.g. 2 for 2 %)
     *   - feeAddress: where the single fee coinbase output lands
     *   - coinbaseWeightBudget: max WU reserved for the whole coinbase
     *   - dustLimitSats: per-output minimum (546 — outputs below stay
     *     in the ledger as pending credit)
     *   - coinbaseBaseWeight / coinbaseOutputWeight / coinbaseWitnessCommitmentWeight:
     *     the structural WU numbers the algorithm uses to decide
     *     "how many miners fit in this block's coinbase".
     *   - minDifficulty: VarDiff floor on the PPLNS port
     *     (PPLNS_MIN_DIFFICULTY, default 500). Sub-500-GH/s devices
     *     cannot sustain this target and are effectively locked out.
     *   - warmupShares: per-session ledger-warmup gate on the PPLNS
     *     port (PPLNS_WARMUP_SHARES, default 10). First N shares are
     *     validated but not added to the PPLNS ledger, filtering
     *     CPU / low-hashrate miners that briefly reach the min diff.
     */
    @Get('fees')
    getFees() {
        const gate = this.pplnsService.getPortGateConfig();
        return {
            ...this.pplnsService.getFeeConfig(),
            dustLimitSats: DUST_LIMIT_SATS,
            coinbaseBaseWeight: COINBASE_BASE_WEIGHT,
            coinbaseOutputWeight: COINBASE_OUTPUT_WEIGHT,
            coinbaseWitnessCommitmentWeight: COINBASE_WITNESS_COMMITMENT_WEIGHT,
            minDifficulty: gate.minDifficulty,
            warmupShares: gate.warmupShares,
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
     * GET /pplns/ledger
     * Pool-wide signed-ledger summary plus the abandonment window the
     * UI renders on the PPLNS Info page.
     *
     * Fields:
     *   - totalCreditSats:    sum of positive balances (pool owes miners)
     *   - totalDebitSats:     sum of absolute negative balances (miners owe pool)
     *   - netDriftSats:       signed sum (hovers near 0)
     *   - creditHolderCount / debitHolderCount
     *   - abandonedCreditSats / abandonedDebitSats: rows whose miner has
     *     been inactive longer than `abandonedDays`; next nightly sweep
     *     will pair-cancel credit ↔ debit matches.
     *   - abandonedDays: configured inactivity threshold in days
     *     (ABANDONED_BALANCE_DAYS, default 90 = 3 months). Exposed so
     *     the UI can render "abandoned after N days" in its own locale.
     *   - lifetimePaidSats:   sum of totalPaidSats across every miner row
     */
    @Get('ledger')
    async getLedgerSummary() {
        const abandonedDays = this.dustSweepService.getAbandonedDays();
        const summary = await this.pplnsService.getLedgerSummary(abandonedDays);
        return { ...summary, abandonedDays };
    }

    /**
     * GET /pplns/:address
     * PPLNS status for a specific miner address.
     *
     * Response includes:
     *   - balanceSats: signed ledger balance
     *                     > 0  pool owes miner (pending credit)
     *                     < 0  miner owes pool (outstanding debit from
     *                          an earlier on-chain bonus)
     *                     = 0  no open claim
     *   - balanceLabel: 'credit' | 'debit' | 'zero' — ready-to-render category
     *   - totalPaidSats: lifetime on-chain payouts via this engine
     *   - currentWindowDifficulty / currentWindowPercent
     */
    @Get(':address')
    async getAddressStatus(@Param('address') address: string) {
        const status = await this.pplnsService.getAddressStatus(address);
        const balanceLabel = status.balanceSats > 0
            ? 'credit'
            : status.balanceSats < 0
                ? 'debit'
                : 'zero';
        return { ...status, balanceLabel };
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
