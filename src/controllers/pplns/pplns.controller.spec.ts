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
                totalDifficulty: 0, windowSize: 0, shareCount: 0, minerCount: 0,
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
        const controller = new PplnsController(
            pplnsService as any,
            clientStatisticsService as any,
            clientService as any,
            miningModeService as any,
            poolModeHashrateService as any,
        );
        return { controller, pplnsService, clientStatisticsService, clientService, miningModeService, poolModeHashrateService };
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
                windowStats: { totalDifficulty: 1000, windowSize: 4000, shareCount: 2, minerCount: 2 },
            });

            const res = await controller.info();

            expect(clientService.getUserAgentsForAddresses).toHaveBeenCalledWith(['bc1qalice', 'bc1qbob']);
            expect(res).toEqual({
                enabled: true,
                totalDifficulty: 1000,
                windowSize: 4000,
                shareCount: 2,
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
});
