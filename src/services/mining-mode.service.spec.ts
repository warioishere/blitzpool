jest.mock('node-telegram-bot-api', () => jest.fn());

import { MiningModeService, MiningMode } from './mining-mode.service';

describe('MiningModeService.getMode', () => {

    function setup(opts: {
        distribution?: { address: string; difficulty: number; percent: number }[];
        groupForAddress?: Record<string, { groupId: string; active: boolean } | undefined>;
        /** Simulates the Redis port-marker set by the stratum layer. */
        liveMarker?: Record<string, MiningMode>;
    }) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution ?? []),
        };
        const groupService = {
            getGroupForAddress: jest.fn((address: string) => opts.groupForAddress?.[address]),
        };
        const minerActiveModeService = {
            get: jest.fn(async (address: string) => opts.liveMarker?.[address] ?? null),
            mark: jest.fn(),
        };
        return new MiningModeService(
            pplnsService as any,
            groupService as any,
            minerActiveModeService as any,
        );
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

    // ── Live port-marker tests ────────────────────────────────────────
    // The marker is the primary signal — it reflects the port the miner
    // is ACTUALLY connected to right now. Only when the marker is
    // absent/expired does the service fall back to PPLNS window / group
    // state. These cases cover the port-switch recovery scenario that
    // the legacy state-based detection handled with hours of lag.

    it('live marker "solo" overrides stale PPLNS window shares', async () => {
        // Scenario: miner PPLNS-tested for 1h, then switched back to
        // solo port. Their old PPLNS shares are still in the window,
        // but new shares are landing as solo. Marker says solo,
        // detection must reflect that.
        const svc = setup({
            liveMarker: { 'bc1qalice': 'solo' },
            distribution: [{ address: 'bc1qalice', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'solo' });
    });

    it('live marker "group-solo" overrides stale PPLNS window shares', async () => {
        // Scenario: group member tested PPLNS, then went back to
        // solo port (where address-driven group routing kicks in).
        const svc = setup({
            liveMarker: { 'bc1qalice': 'group-solo' },
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
            distribution: [{ address: 'bc1qalice', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'group-solo', groupId: 'grp-1' });
    });

    it('live marker "pplns" wins even when address is also in a group', async () => {
        // Complementary to the "port-flip override" test above —
        // confirmed via live marker this time.
        const svc = setup({
            liveMarker: { 'bc1qalice': 'pplns' },
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'pplns' });
    });

    it('live marker "group-solo" falls through when the group no longer exists', async () => {
        // Defensive: a group-solo marker set right before the group was
        // dissolved. Detection must not return a dangling groupId.
        const svc = setup({
            liveMarker: { 'bc1qalice': 'group-solo' },
            // No groupForAddress entry — group was dissolved.
            distribution: [{ address: 'bc1qalice', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'pplns' });
    });

    it('legacy detection kicks in when no live marker is set', async () => {
        // An offline miner has no recent marker. The fallback should
        // behave exactly as it did before the marker was introduced.
        const svc = setup({
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'group-solo', groupId: 'grp-1' });
    });
});
