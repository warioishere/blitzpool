jest.mock('node-telegram-bot-api', () => jest.fn());

import { MiningModeService, MiningMode } from './mining-mode.service';

describe('MiningModeService.getMode', () => {

    function setup(opts: {
        distribution?: { address: string; difficulty: number; percent: number }[];
        groupForAddress?: Record<string, { groupId: string; active: boolean } | undefined>;
        /** Admin-address → groupId map for Blockparty lookup. */
        blockpartyAdmins?: Record<string, string>;
        /** Simulates the Redis port-marker set by the stratum layer. */
        liveMarker?: Record<string, MiningMode>;
    }) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution ?? []),
        };
        const groupService = {
            getGroupForAddress: jest.fn((address: string) => opts.groupForAddress?.[address]),
        };
        const blockpartyService = {
            getGroupIdForAdminAddress: jest.fn((address: string) => opts.blockpartyAdmins?.[address]),
        };
        const minerActiveModeService = {
            get: jest.fn(async (address: string) => opts.liveMarker?.[address] ?? null),
            mark: jest.fn(),
        };
        return new MiningModeService(
            pplnsService as any,
            groupService as any,
            blockpartyService as any,
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

    it('group membership wins over residual PPLNS-window shares in the fallback', async () => {
        // Without a live port-marker the fallback used to surface PPLNS
        // first, which left group admins / creators stuck on /payout-pplns
        // for as long as their old PPLNS shares stayed in the 4× window
        // (sometimes weeks). Group membership is an intentional admin
        // action — it should win over residual passive PPLNS state. The
        // live port-marker (checked above this branch) still wins for
        // miners actively connected on the PPLNS port, so the share-
        // routing semantic is unchanged.
        const svc = setup({
            groupForAddress: { 'bc1qalice': { groupId: 'grp-1', active: true } },
            distribution: [{ address: 'bc1qalice', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qalice')).toEqual({ mode: 'group-solo', groupId: 'grp-1' });
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

    // ── Blockparty precedence ─────────────────────────────────────────

    it('blockparty admin address resolves to blockparty mode via live marker', async () => {
        const svc = setup({
            blockpartyAdmins: { 'bc1qadmin': 'bp-1' },
            liveMarker: { 'bc1qadmin': 'blockparty' },
        });
        expect(await svc.getMode('bc1qadmin')).toEqual({ mode: 'blockparty', groupId: 'bp-1' });
    });

    it('blockparty wins over group-solo and pplns in the legacy fallback', async () => {
        // Same address is somehow listed in all three modes (impossible in
        // practice with bidirectional collision checks, but the precedence
        // must be deterministic if it ever happens — e.g. stale state).
        const svc = setup({
            blockpartyAdmins: { 'bc1qadmin': 'bp-1' },
            groupForAddress: { 'bc1qadmin': { groupId: 'gs-1', active: true } },
            distribution: [{ address: 'bc1qadmin', difficulty: 500, percent: 50 }],
        });
        expect(await svc.getMode('bc1qadmin')).toEqual({ mode: 'blockparty', groupId: 'bp-1' });
    });

    it('blockparty live marker falls through when the party was dissolved', async () => {
        // Marker still in Redis for 5min but the party is gone — fallback
        // to whatever the address ALSO matches in the legacy chain.
        const svc = setup({
            blockpartyAdmins: {}, // no live blockparty for this admin anymore
            groupForAddress: { 'bc1qadmin': { groupId: 'gs-1', active: true } },
            liveMarker: { 'bc1qadmin': 'blockparty' },
        });
        expect(await svc.getMode('bc1qadmin')).toEqual({ mode: 'group-solo', groupId: 'gs-1' });
    });

    // ── Per-address result cache ──────────────────────────────────────
    // /api/pplns/mode/:address is uncached and polled per dashboard view.
    // Without the cache, every poll did Redis GET + (on miss) HGETALL over
    // the PPLNS window. TTL=30s is shorter than the live-marker TTL so
    // port-switch detection still propagates within one poll cycle.

    function setupWithSpies(opts: Parameters<typeof setup>[0]) {
        const pplnsService = {
            getCurrentDistribution: jest.fn().mockResolvedValue(opts.distribution ?? []),
        };
        const groupService = {
            getGroupForAddress: jest.fn((address: string) => opts.groupForAddress?.[address]),
        };
        const blockpartyService = {
            getGroupIdForAdminAddress: jest.fn((address: string) => opts.blockpartyAdmins?.[address]),
        };
        const minerActiveModeService = {
            get: jest.fn(async (address: string) => opts.liveMarker?.[address] ?? null),
            mark: jest.fn(),
        };
        const svc = new MiningModeService(
            pplnsService as any,
            groupService as any,
            blockpartyService as any,
            minerActiveModeService as any,
        );
        return { svc, pplnsService, groupService, blockpartyService, minerActiveModeService };
    }

    it('caches subsequent calls for the same address within 30s', async () => {
        const { svc, minerActiveModeService } = setupWithSpies({
            liveMarker: { 'bc1qalice': 'pplns' },
        });
        await svc.getMode('bc1qalice');
        await svc.getMode('bc1qalice');
        await svc.getMode('bc1qalice');
        expect(minerActiveModeService.get).toHaveBeenCalledTimes(1);
    });

    it('caches per address — different addresses do not share state', async () => {
        const { svc, minerActiveModeService } = setupWithSpies({
            liveMarker: { 'bc1qalice': 'pplns', 'bc1qbob': 'solo' },
        });
        await svc.getMode('bc1qalice');
        await svc.getMode('bc1qbob');
        expect(minerActiveModeService.get).toHaveBeenCalledTimes(2);
    });

    it('invalidate() drops the cached entry so the next call re-computes', async () => {
        const { svc, minerActiveModeService } = setupWithSpies({
            liveMarker: { 'bc1qalice': 'solo' },
        });
        await svc.getMode('bc1qalice');
        svc.invalidate('bc1qalice');
        await svc.getMode('bc1qalice');
        expect(minerActiveModeService.get).toHaveBeenCalledTimes(2);
    });

    it('re-computes after the cache TTL elapses', async () => {
        jest.useFakeTimers();
        try {
            const { svc, minerActiveModeService } = setupWithSpies({
                liveMarker: { 'bc1qalice': 'solo' },
            });
            await svc.getMode('bc1qalice');
            jest.setSystemTime(Date.now() + 31_000);
            await svc.getMode('bc1qalice');
            expect(minerActiveModeService.get).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });
});
