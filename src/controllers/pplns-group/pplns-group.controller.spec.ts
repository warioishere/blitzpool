jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsGroupController } from './pplns-group.controller';
import { HttpException } from '@nestjs/common';

describe('PplnsGroupController.chart', () => {

    function setup(opts: {
        group?: { id: string; dissolvedAt: Date | null };
        members?: { address: string }[];
        chartByAddress?: Record<string, { label: string; data: number }[]>;
    }) {
        const groupService = {
            getGroup: jest.fn().mockResolvedValue(opts.group ?? null),
            listMembers: jest.fn().mockResolvedValue(opts.members ?? []),
        };
        const groupSoloService = {} as any;
        const invitationService = {} as any;
        const clientService = {} as any;
        const clientStatisticsService = {
            getChartDataForAddress: jest.fn(async (address: string) =>
                opts.chartByAddress?.[address] ?? [],
            ),
        };
        const clientRejectedStatisticsService = {} as any;
        const controller = new PplnsGroupController(
            groupService as any,
            groupSoloService,
            invitationService,
            clientService,
            clientStatisticsService as any,
            clientRejectedStatisticsService,
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
            group: { id: 'g1', dissolvedAt: new Date() },
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
