jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsController } from './pplns.controller';

describe('PplnsController.getMiningMode', () => {

    function setup(opts: {
        distribution?: { address: string; difficulty: number; percent: number }[];
        groupForAddress?: Record<string, { groupId: string; active: boolean } | undefined>;
    }) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution ?? []),
        };
        const groupService = {
            getGroupForAddress: jest.fn((address: string) => opts.groupForAddress?.[address]),
        };
        const controller = new PplnsController(pplnsService as any, groupService as any);
        return { controller, pplnsService, groupService };
    }

    it('returns group-solo when the address is in an active group', async () => {
        const { controller } = setup({
            groupForAddress: {
                'bc1qalice': { groupId: 'grp-1', active: true },
            },
        });
        const res = await controller.getMiningMode('bc1qalice');
        expect(res).toEqual({ mode: 'group-solo', groupId: 'grp-1' });
    });

    it('ignores inactive group membership and falls through to pplns/solo', async () => {
        // Group exists but hasn't reached min 2 members yet → inactive.
        // The address isn't routed to group-solo until activation.
        const { controller } = setup({
            groupForAddress: {
                'bc1qalice': { groupId: 'grp-1', active: false },
            },
            distribution: [
                { address: 'bc1qalice', difficulty: 100, percent: 100 },
            ],
        });
        const res = await controller.getMiningMode('bc1qalice');
        expect(res).toEqual({ mode: 'pplns' });
    });

    it('returns pplns when the address has shares in the window but no group', async () => {
        const { controller } = setup({
            distribution: [
                { address: 'bc1qbob', difficulty: 200, percent: 100 },
            ],
        });
        const res = await controller.getMiningMode('bc1qbob');
        expect(res).toEqual({ mode: 'pplns' });
    });

    it('returns solo when the address has no group and no PPLNS window shares', async () => {
        const { controller } = setup({
            distribution: [
                { address: 'bc1qother', difficulty: 100, percent: 100 },
            ],
        });
        const res = await controller.getMiningMode('bc1qcharlie');
        expect(res).toEqual({ mode: 'solo' });
    });

    it('returns solo when no groups exist and no PPLNS activity at all', async () => {
        const { controller } = setup({});
        const res = await controller.getMiningMode('bc1qnew');
        expect(res).toEqual({ mode: 'solo' });
    });
});
