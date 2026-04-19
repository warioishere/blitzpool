jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsController } from './pplns.controller';

describe('PplnsController', () => {

    function setup(opts: {
        distribution: { address: string; difficulty: number; percent: number }[];
        chartByAddress?: Record<string, { label: string; data: number }[]>;
    }) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution),
        };
        const clientStatisticsService = {
            getChartDataForAddress: jest.fn(async (address: string) =>
                opts.chartByAddress?.[address] ?? [],
            ),
        };
        const controller = new PplnsController(
            pplnsService as any,
            clientStatisticsService as any,
        );
        return { controller, pplnsService, clientStatisticsService };
    }

    describe('getChart', () => {
        it('sums per-address time-series into one aggregated chart (same label → added data)', async () => {
            const { controller } = setup({
                distribution: [
                    { address: 'bc1qalice', difficulty: 800, percent: 80 },
                    { address: 'bc1qbob',   difficulty: 200, percent: 20 },
                ],
                chartByAddress: {
                    'bc1qalice': [
                        { label: '2026-04-19T10:00:00.000Z', data: 500e9 },
                        { label: '2026-04-19T10:10:00.000Z', data: 520e9 },
                    ],
                    'bc1qbob': [
                        { label: '2026-04-19T10:00:00.000Z', data: 200e9 },
                        { label: '2026-04-19T10:10:00.000Z', data: 210e9 },
                    ],
                },
            });

            const chart = await controller.getChart('1d');

            expect(chart).toEqual([
                { label: '2026-04-19T10:00:00.000Z', data: 700e9 },
                { label: '2026-04-19T10:10:00.000Z', data: 730e9 },
            ]);
        });

        it('handles addresses with partial data (sparse timestamps)', async () => {
            // Alice has 10:00 and 10:10; Bob only has 10:10. The 10:00 slot should
            // just contain Alice's data without a "missing Bob = 0" phantom entry.
            const { controller } = setup({
                distribution: [
                    { address: 'bc1qalice', difficulty: 100, percent: 50 },
                    { address: 'bc1qbob',   difficulty: 100, percent: 50 },
                ],
                chartByAddress: {
                    'bc1qalice': [
                        { label: '2026-04-19T10:00:00.000Z', data: 500e9 },
                        { label: '2026-04-19T10:10:00.000Z', data: 500e9 },
                    ],
                    'bc1qbob': [
                        { label: '2026-04-19T10:10:00.000Z', data: 300e9 },
                    ],
                },
            });

            const chart = await controller.getChart('1d');

            expect(chart).toEqual([
                { label: '2026-04-19T10:00:00.000Z', data: 500e9 },
                { label: '2026-04-19T10:10:00.000Z', data: 800e9 },
            ]);
        });

        it('returns an empty array when no addresses are in the window', async () => {
            const { controller } = setup({ distribution: [] });
            expect(await controller.getChart('1d')).toEqual([]);
        });

        it('passes the range parameter through to ClientStatisticsService', async () => {
            const { controller, clientStatisticsService } = setup({
                distribution: [{ address: 'bc1qa', difficulty: 1, percent: 100 }],
                chartByAddress: { 'bc1qa': [] },
            });

            await controller.getChart('7d');

            expect(clientStatisticsService.getChartDataForAddress).toHaveBeenCalledWith('bc1qa', '7d');
        });

        it('defaults to 1d when an unknown range is passed', async () => {
            const { controller, clientStatisticsService } = setup({
                distribution: [{ address: 'bc1qa', difficulty: 1, percent: 100 }],
                chartByAddress: { 'bc1qa': [] },
            });

            await controller.getChart('something-weird' as any);

            expect(clientStatisticsService.getChartDataForAddress).toHaveBeenCalledWith('bc1qa', '1d');
        });
    });
});
