jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsController } from './pplns.controller';

describe('PplnsController', () => {

    function setup(opts: {
        distribution?: { address: string; difficulty: number; percent: number }[];
        chartByAddress?: Record<string, { label: string; data: number }[]>;
        userAgents?: any[];
        enabled?: boolean;
        windowStats?: any;
    }) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution ?? []),
            isEnabled: jest.fn().mockReturnValue(opts.enabled ?? true),
            getWindowStats: jest.fn().mockResolvedValue(opts.windowStats ?? {
                totalShares: 0, windowSize: 0, minerCount: 0,
            }),
            getAddressStatus: jest.fn().mockResolvedValue({
                balanceSats: 0,
                totalPaidSats: 0,
                currentWindowShares: 0,
                currentWindowPercent: 0,
            }),
            getLedgerSummary: jest.fn().mockResolvedValue({
                totalCreditSats: 0,
                totalDebitSats: 0,
                netDriftSats: 0,
                creditHolderCount: 0,
                debitHolderCount: 0,
                abandonedCreditSats: 0,
                abandonedDebitSats: 0,
                lifetimePaidSats: 0,
            }),
        };
        const clientStatisticsService = {
            getChartDataForAddress: jest.fn(async (address: string) =>
                opts.chartByAddress?.[address] ?? [],
            ),
        };
        const clientService = {
            getUserAgentsForAddresses: jest.fn(async () => opts.userAgents ?? []),
        };
        const miningModeService = {
            getMode: jest.fn().mockResolvedValue({ mode: 'pplns' }),
        };
        const poolModeHashrateService = {
            getChart: jest.fn().mockResolvedValue([]),
            incrementAccepted: jest.fn(),
        };
        const dustSweepService = {
            getAbandonedDays: jest.fn().mockReturnValue(180),
            getDormantDays: jest.fn().mockReturnValue(30),
        };
        const controller = new PplnsController(
            pplnsService as any,
            clientStatisticsService as any,
            clientService as any,
            miningModeService as any,
            poolModeHashrateService as any,
            dustSweepService as any,
        );
        return { controller, pplnsService, clientStatisticsService, clientService, miningModeService, poolModeHashrateService, dustSweepService };
    }

    describe('info', () => {
        it('returns enabled flag, window stats, and user agents limited to PPLNS addresses', async () => {
            const { controller, clientService } = setup({
                distribution: [
                    { address: 'bc1qalice', difficulty: 800, percent: 80 },
                    { address: 'bc1qbob',   difficulty: 200, percent: 20 },
                ],
                userAgents: [
                    { userAgent: 'Bitaxe/2.1.15', count: '2', bestDifficulty: '8192', totalHashRate: '1000000000000' },
                ],
                enabled: true,
                windowStats: { totalShares: 1000, windowSize: 4000, minerCount: 2 },
            });

            const res = await controller.info();

            expect(clientService.getUserAgentsForAddresses).toHaveBeenCalledWith(['bc1qalice', 'bc1qbob']);
            expect(res).toEqual({
                enabled: true,
                totalShares: 1000,
                windowSize: 4000,
                minerCount: 2,
                userAgents: [
                    { userAgent: 'Bitaxe/2.1.15', count: '2', bestDifficulty: '8192', totalHashRate: '1000000000000' },
                ],
            });
        });

        it('returns empty userAgents when window is empty', async () => {
            const { controller } = setup({
                distribution: [],
                userAgents: [],
                enabled: false,
            });

            const res = await controller.info();

            expect(res.userAgents).toEqual([]);
            expect(res.enabled).toBe(false);
        });
    });

    describe('getChart', () => {
        // The old implementation walked every address currently in the PPLNS
        // window and summed their full per-address hashrate charts. That
        // double-counted non-PPLNS hashrate whenever an address was still
        // in the window from an earlier PPLNS test but was now mining
        // group-solo or solo. The current controller delegates to
        // PoolModeHashrateService, which only counts shares actually routed
        // to PPLNS — per-mode at write time, not per-address at read time.

        it('delegates to PoolModeHashrateService.getChart with mode=pplns', async () => {
            const { controller, poolModeHashrateService } = setup({});
            const fixture = [
                { label: '2026-04-22T08:10:00.000Z', data: 1.1e12 },
                { label: '2026-04-22T08:20:00.000Z', data: 1.3e12 },
            ];
            (poolModeHashrateService.getChart as jest.Mock).mockResolvedValue(fixture);

            const chart = await controller.getChart('1d');

            expect(poolModeHashrateService.getChart).toHaveBeenCalledWith('pplns', '1d');
            expect(chart).toEqual(fixture);
        });

        it('passes the range parameter through', async () => {
            const { controller, poolModeHashrateService } = setup({});
            await controller.getChart('7d');
            expect(poolModeHashrateService.getChart).toHaveBeenCalledWith('pplns', '7d');
        });

        it('defaults to 1d when an unknown range is passed', async () => {
            const { controller, poolModeHashrateService } = setup({});
            await controller.getChart('something-weird' as any);
            expect(poolModeHashrateService.getChart).toHaveBeenCalledWith('pplns', '1d');
        });

        it('returns whatever the service returns (including empty)', async () => {
            const { controller, poolModeHashrateService } = setup({});
            (poolModeHashrateService.getChart as jest.Mock).mockResolvedValue([]);
            expect(await controller.getChart('1d')).toEqual([]);
        });
    });

    describe('getMiningMode', () => {
        it('delegates to MiningModeService.getMode', async () => {
            const { controller, miningModeService } = setup({ distribution: [] });
            const res = await controller.getMiningMode('bc1qfoo');
            expect(miningModeService.getMode).toHaveBeenCalledWith('bc1qfoo');
            expect(res).toEqual({ mode: 'pplns' });
        });
    });

    describe('getAddressStatus (signed ledger)', () => {
        it('returns "credit" label for positive balance', async () => {
            const { controller, pplnsService } = setup({});
            (pplnsService.getAddressStatus as jest.Mock).mockResolvedValue({
                balanceSats: 1234,
                totalPaidSats: 5000,
                currentWindowShares: 100,
                currentWindowPercent: 25,
            });
            const res = await controller.getAddressStatus('bc1qa');
            expect(res.balanceSats).toBe(1234);
            expect(res.balanceLabel).toBe('credit');
        });

        it('returns "debit" label for negative balance', async () => {
            const { controller, pplnsService } = setup({});
            (pplnsService.getAddressStatus as jest.Mock).mockResolvedValue({
                balanceSats: -500,
                totalPaidSats: 20000,
                currentWindowShares: 50,
                currentWindowPercent: 10,
            });
            const res = await controller.getAddressStatus('bc1qa');
            expect(res.balanceSats).toBe(-500);
            expect(res.balanceLabel).toBe('debit');
        });

        it('returns "zero" label for balance of 0', async () => {
            const { controller } = setup({});
            const res = await controller.getAddressStatus('bc1qa');
            expect(res.balanceSats).toBe(0);
            expect(res.balanceLabel).toBe('zero');
        });
    });

    describe('getLedgerSummary', () => {
        it('returns pool-wide signed-ledger aggregates + abandonment threshold', async () => {
            const { controller, pplnsService, dustSweepService } = setup({});
            (pplnsService.getLedgerSummary as jest.Mock).mockResolvedValue({
                totalCreditSats: 5000,
                totalDebitSats: 4800,
                netDriftSats: 200,
                creditHolderCount: 12,
                debitHolderCount: 3,
                abandonedCreditSats: 700,
                abandonedDebitSats: 200,
                lifetimePaidSats: 12_345_678,
            });
            (dustSweepService.getAbandonedDays as jest.Mock).mockReturnValue(180);
            const res = await controller.getLedgerSummary();
            expect(dustSweepService.getAbandonedDays).toHaveBeenCalled();
            expect(pplnsService.getLedgerSummary).toHaveBeenCalledWith(180);
            expect(res.totalCreditSats).toBe(5000);
            expect(res.totalDebitSats).toBe(4800);
            expect(res.netDriftSats).toBe(200);
            expect(res.creditHolderCount).toBe(12);
            expect(res.debitHolderCount).toBe(3);
            expect(res.abandonedCreditSats).toBe(700);
            expect(res.abandonedDebitSats).toBe(200);
            expect(res.lifetimePaidSats).toBe(12_345_678);
            expect(res.abandonedDays).toBe(180);
        });
    });

    describe('getFees', () => {
        it('returns fee config + dust limit + coinbase weight constants + PPLNS-port gate', () => {
            const { controller, pplnsService } = setup({});
            (pplnsService as any).getFeeConfig = jest.fn().mockReturnValue({
                feePercent: 2,
                feeAddress: 'bc1qfee',
                coinbaseWeightBudget: 50000,
            });
            (pplnsService as any).getPortGateConfig = jest.fn().mockReturnValue({
                minDifficulty: 500,
                warmupShares: 10,
            });
            (pplnsService as any).getMaxCoinbaseOutputs = jest.fn().mockReturnValue(286);
            (pplnsService as any).getMinPayoutSats = jest.fn().mockReturnValue(5000);
            const res: any = controller.getFees();
            expect(res.feePercent).toBe(2);
            expect(res.feeAddress).toBe('bc1qfee');
            expect(res.coinbaseWeightBudget).toBe(50000);
            expect(res.dustLimitSats).toBe(546);
            expect(res.minPayoutSats).toBe(5000);
            expect(res.coinbaseBaseWeight).toBe(328);
            expect(res.coinbaseOutputWeight).toBe(172);
            expect(res.coinbaseWitnessCommitmentWeight).toBe(188);
            expect(res.maxMinerOutputs).toBe(286);
            expect(res.minDifficulty).toBe(500);
            expect(res.warmupShares).toBe(10);
        });
    });
});
