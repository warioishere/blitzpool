jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsGroupController } from './pplns-group.controller';
import { HttpException } from '@nestjs/common';

describe('PplnsGroupController.chart', () => {

    function setup(opts: {
        group?: { id: string; dissolvedAt: number | null };
        members?: { address: string }[];
        chartByAddress?: Record<string, { label: string; data: number }[]>;
    }) {
        const groupService = {
            getGroup: jest.fn().mockResolvedValue(opts.group ?? null),
            listMembers: jest.fn().mockResolvedValue(opts.members ?? []),
        };
        const groupSoloService = {} as any;
        const invitationService = {} as any;
        const addressEmailService = {} as any;
        const clientService = {} as any;
        const clientStatisticsService = {
            getChartDataForAddress: jest.fn(async (address: string) =>
                opts.chartByAddress?.[address] ?? [],
            ),
        };
        const clientRejectedStatisticsService = {} as any;
        const configService = { get: jest.fn(() => undefined) } as any;
        const joinRequestService = {} as any;
        const pplnsService = {
            getFeeConfig: jest.fn(() => ({ feePercent: 2, feeAddress: 'bc1qfee', coinbaseWeightBudget: 36000 })),
            getMaxCoinbaseOutputs: jest.fn(() => 200),
        } as any;
        const bitcoinRpcService = { getBlockHeight: jest.fn(() => 800_000) } as any;
        const controller = new PplnsGroupController(
            groupService as any,
            groupSoloService,
            invitationService,
            addressEmailService,
            clientService,
            clientStatisticsService as any,
            clientRejectedStatisticsService,
            configService,
            joinRequestService,
            pplnsService,
            bitcoinRpcService,
        );
        return { controller, groupService, clientStatisticsService };
    }

    it('sums per-member time-series with matching labels', async () => {
        const { controller } = setup({
            group: { id: 'g1', dissolvedAt: null },
            members: [{ address: 'bc1qalice' }, { address: 'bc1qbob' }],
            chartByAddress: {
                'bc1qalice': [
                    { label: '2026-04-19T10:00:00.000Z', data: 500e9 },
                    { label: '2026-04-19T10:10:00.000Z', data: 520e9 },
                ],
                'bc1qbob': [
                    { label: '2026-04-19T10:00:00.000Z', data: 300e9 },
                    { label: '2026-04-19T10:10:00.000Z', data: 310e9 },
                ],
            },
        });

        const chart = await controller.chart('g1', '1d');

        expect(chart).toEqual([
            { label: '2026-04-19T10:00:00.000Z', data: 800e9 },
            { label: '2026-04-19T10:10:00.000Z', data: 830e9 },
        ]);
    });

    it('handles sparse per-member data (missing slots do not create phantom zeros)', async () => {
        const { controller } = setup({
            group: { id: 'g1', dissolvedAt: null },
            members: [{ address: 'bc1qalice' }, { address: 'bc1qbob' }],
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

        const chart = await controller.chart('g1', '1d');

        expect(chart).toEqual([
            { label: '2026-04-19T10:00:00.000Z', data: 500e9 },
            { label: '2026-04-19T10:10:00.000Z', data: 800e9 },
        ]);
    });

    it('returns empty array when the group has no members', async () => {
        const { controller } = setup({
            group: { id: 'g1', dissolvedAt: null },
            members: [],
        });
        expect(await controller.chart('g1', '1d')).toEqual([]);
    });

    it('returns 404 when the group does not exist', async () => {
        const { controller } = setup({ group: undefined });
        await expect(controller.chart('missing', '1d')).rejects.toBeInstanceOf(HttpException);
    });

    it('returns 404 when the group has been dissolved', async () => {
        const { controller } = setup({
            group: { id: 'g1', dissolvedAt: Date.now() },
        });
        await expect(controller.chart('g1', '1d')).rejects.toBeInstanceOf(HttpException);
    });

    it('passes the range through unchanged for valid values', async () => {
        const { controller, clientStatisticsService } = setup({
            group: { id: 'g1', dissolvedAt: null },
            members: [{ address: 'bc1qa' }],
            chartByAddress: { 'bc1qa': [] },
        });

        await controller.chart('g1', '7d');

        expect(clientStatisticsService.getChartDataForAddress).toHaveBeenCalledWith('bc1qa', '7d');
    });

    it('falls back to 1d when the range is unknown', async () => {
        const { controller, clientStatisticsService } = setup({
            group: { id: 'g1', dissolvedAt: null },
            members: [{ address: 'bc1qa' }],
            chartByAddress: { 'bc1qa': [] },
        });

        await controller.chart('g1', 'unsupported' as any);

        expect(clientStatisticsService.getChartDataForAddress).toHaveBeenCalledWith('bc1qa', '1d');
    });
});

describe('PplnsGroupController capacity endpoints', () => {
    function make(opts: {
        feeAddress?: string;
        coinbaseWeightBudget?: number;
        maxOutputs?: number;
        blockHeight?: number;
    } = {}) {
        const pplnsService = {
            getFeeConfig: jest.fn(() => ({
                feePercent: 2,
                feeAddress: opts.feeAddress ?? 'bc1qfee',
                coinbaseWeightBudget: opts.coinbaseWeightBudget ?? 36000,
            })),
            getMaxCoinbaseOutputs: jest.fn(() => opts.maxOutputs ?? 200),
        } as any;
        const bitcoinRpcService = { getBlockHeight: jest.fn(() => opts.blockHeight ?? 800_000) } as any;
        const noop = {} as any;
        return new PplnsGroupController(
            noop, noop, noop, noop, noop, noop, noop, noop, noop,
            pplnsService, bitcoinRpcService,
        );
    }

    it('coinbase-capacity returns maxMembers + weightBudget + hasFeeOutput', () => {
        const c = make({ maxOutputs: 287, coinbaseWeightBudget: 50000 });
        expect(c.coinbaseCapacity()).toEqual({
            maxMembers: 287,
            weightBudget: 50000,
            hasFeeOutput: true,
        });
    });

    it('coinbase-capacity reports hasFeeOutput=false when no fee address is set', () => {
        const c = make({ feeAddress: '' });
        expect(c.coinbaseCapacity().hasFeeOutput).toBe(false);
    });

    it('finder-bonus-cap returns next-block height + its subsidy', () => {
        // height 800001 → 3 halvings → 5e9 / 8 = 625_000_000 sats.
        const c = make({ blockHeight: 800_000 });
        expect(c.finderBonusCap()).toEqual({ height: 800_001, subsidySats: 625_000_000 });
    });
});
