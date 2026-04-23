jest.mock('node-telegram-bot-api', () => jest.fn());

import { MiningModeService } from './mining-mode.service';

describe('MiningModeService.getMode', () => {

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
        return new MiningModeService(pplnsService as any, groupService as any);
    }

    it('returns group-solo when the address is in an active group with no PPLNS shares', async () => {
        // No PPLNS window activity → fall through to group-solo.
        const svc = setup({
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'group-solo', groupId: 'grp-1' });
    });

    it('PPLNS takes precedence over group membership (port-flip override)', async () => {
        // A group member who started mining on the PPLNS port has shares
        // landing in the PPLNS window. Share-routing at the stratum layer
        // gives PPLNS precedence over group-solo in that case; the
        // mode-detection API mirrors the same priority so the UI reflects
        // where the miner's shares are actually going.
        const svc = setup({
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
            distribution: [{ address: 'bc1qalice', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'pplns' });
    });

    it('ignores inactive group membership and falls through to pplns/solo', async () => {
        // Group exists but hasn't reached min 2 members yet → inactive.
        // The address isn't routed to group-solo until activation.
        const svc = setup({
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: false } },
            distribution: [{ address: 'bc1qalice', difficulty: 100, percent: 100 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'pplns' });
    });

    it('returns pplns when the address has shares in the window but no group', async () => {
        const svc = setup({
            distribution: [{ address: 'bc1qbob', difficulty: 200, percent: 100 }],
        });
        expect(await svc.getMode('bc1qbob')).toEqual({ mode: 'pplns' });
    });

    it('returns solo when the address has no group and no PPLNS window shares', async () => {
        const svc = setup({
            distribution: [{ address: 'bc1qother', difficulty: 100, percent: 100 }],
        });
        expect(await svc.getMode('bc1qcharlie')).toEqual({ mode: 'solo' });
    });

    it('returns solo when no groups exist and no PPLNS activity at all', async () => {
        const svc = setup({});
        expect(await svc.getMode('bc1qnew')).toEqual({ mode: 'solo' });
    });
});
