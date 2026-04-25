jest.mock('node-telegram-bot-api', () => jest.fn());

import { GroupService, GroupServiceError } from './group.service';

// ── Mock Repos ──────────────────────────────────────────────────

function createMockRepo<T extends { id?: any }>(target: string = 'unknown') {
    const rows = new Map<any, T>();
    let nextNumeric = 1;

    return {
        _rows: rows,
        target,
        save: jest.fn(async (row: T) => {
            if (!row.id) {
                (row as any).id = typeof (row as any).id === 'number'
                    ? nextNumeric++
                    : 'uuid-' + nextNumeric++;
            }
            rows.set((row as any).id, { ...row });
            return { ...row };
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async (query?: any) => {
            const all = Array.from(rows.values());
            if (!query) return all;
            if (query.where) {
                const where = Array.isArray(query.where) ? query.where : [query.where];
                return all.filter(row =>
                    where.some((w: any) =>
                        Object.entries(w).every(([k, v]) => {
                            if (v && typeof v === 'object' && '_type' in (v as any) && (v as any)._type === 'isNull') {
                                return (row as any)[k] == null;
                            }
                            return (row as any)[k] === v;
                        }),
                    ),
                );
            }
            return all;
        }),
        findOne: jest.fn(async (query: any) => {
            const all = Array.from(rows.values());
            if (!query?.where) return null;
            return all.find(row =>
                Object.entries(query.where).every(([k, v]) => (row as any)[k] === v),
            ) ?? null;
        }),
        findOneBy: jest.fn(async (where: any) => {
            const all = Array.from(rows.values());
            return all.find(row =>
                Object.entries(where).every(([k, v]) => (row as any)[k] === v),
            ) ?? null;
        }),
        count: jest.fn(async (query?: any) => {
            const all = Array.from(rows.values());
            if (!query?.where) return all.length;
            return all.filter(row =>
                Object.entries(query.where).every(([k, v]) => (row as any)[k] === v),
            ).length;
        }),
        delete: jest.fn(async (where: any) => {
            const all = Array.from(rows.entries());
            for (const [id, row] of all) {
                if (Object.entries(where).every(([k, v]) => (row as any)[k] === v)) {
                    rows.delete(id);
                }
            }
        }),
        update: jest.fn(async (where: any, patch: any) => {
            for (const row of rows.values()) {
                if (Object.entries(where).every(([k, v]) => (row as any)[k] === v)) {
                    Object.assign(row, patch);
                }
            }
        }),
    };
}

function createMockConfig(overrides: Record<string, string | undefined> = {}) {
    return {
        get: jest.fn((key: string) => overrides[key]),
    };
}

function createMockGroupSolo() {
    return {
        getMemberLastActive: jest.fn(async () => null),
        removeMemberState: jest.fn(async () => undefined),
        removeGroupState: jest.fn(async () => undefined),
    };
}

// typeorm's IsNull() returns a FindOperator; our mock just recognizes a marker
jest.mock('typeorm', () => ({
    ...jest.requireActual('typeorm'),
    IsNull: () => ({ _type: 'isNull' }),
}));

describe('GroupService', () => {
    let groupRepo: ReturnType<typeof createMockRepo>;
    let memberRepo: ReturnType<typeof createMockRepo>;
    let groupSolo: ReturnType<typeof createMockGroupSolo>;
    let roundReset: { applyConfig: jest.Mock; unschedule: jest.Mock };
    let service: GroupService;

    beforeEach(async () => {
        groupRepo = createMockRepo('group');
        memberRepo = createMockRepo('member');
        groupSolo = createMockGroupSolo();
        roundReset = { applyConfig: jest.fn(), unschedule: jest.fn() };

        // Simulated EntityManager: every getRepository(target) hands back
        // the SAME mock instance keyed by `target`, so writes inside the
        // transaction are visible on the outer mock after commit.
        const repoByTarget: Record<string, any> = {
            group: groupRepo,
            member: memberRepo,
        };
        const manager = {
            transaction: jest.fn(async (cb: (em: any) => Promise<any>) => {
                const em = {
                    getRepository: (target: string) => repoByTarget[target] ?? createMockRepo(target),
                };
                return cb(em);
            }),
        };
        (groupRepo as any).manager = manager;
        (memberRepo as any).manager = manager;

        const config = createMockConfig();
        service = new GroupService(
            groupRepo as any,
            memberRepo as any,
            config as any,
            groupSolo as any,
            roundReset as any,
        );
        await service.onModuleInit();
    });

    // ── Creation ────────────────────────────────────────────────

    it('creates a group and returns a plaintext admin token + hashed DB value', async () => {
        const result = await service.createGroup('my-group', 'bc1qalice');
        expect(result.adminToken).toMatch(/^GRP-/);
        expect(result.group.adminTokenHash).toBeDefined();
        expect(result.group.adminTokenHash).not.toBe(result.adminToken);
        expect(result.group.creatorAddress).toBe('bc1qalice');
        expect(result.group.active).toBe(false); // only 1 member
    });

    it('rejects short group names', async () => {
        await expect(service.createGroup('ab', 'bc1qalice')).rejects.toThrow(GroupServiceError);
    });

    it('adds the creator as first member with role creator', async () => {
        await service.createGroup('group-one', 'bc1qalice');
        const members = Array.from(memberRepo._rows.values()) as any[];
        expect(members).toHaveLength(1);
        expect(members[0].role).toBe('creator');
        expect(members[0].address).toBe('bc1qalice');
    });

    it('rejects creator address already in another group', async () => {
        await service.createGroup('group-one', 'bc1qalice');
        await expect(service.createGroup('group-two', 'bc1qalice'))
            .rejects.toMatchObject({ code: 'address-in-group' });
    });

    // ── Token auth ──────────────────────────────────────────────

    it('accepts valid admin token', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await expect(service.requireAdminToken(group.id, adminToken)).resolves.toBeDefined();
    });

    it('rejects invalid admin token', async () => {
        const { group } = await service.createGroup('group-one', 'bc1qalice');
        await expect(service.requireAdminToken(group.id, 'GRP-wrong')).rejects.toMatchObject({ code: 'invalid-token' });
    });

    it('rejects missing admin token', async () => {
        const { group } = await service.createGroup('group-one', 'bc1qalice');
        await expect(service.requireAdminToken(group.id, undefined)).rejects.toMatchObject({ code: 'missing-token' });
    });

    // ── Membership ──────────────────────────────────────────────

    it('activates group when second member joins', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        const updated: any = await groupRepo.findOneBy({ id: group.id });
        expect(updated.active).toBe(true);
    });

    it('deactivates group when member count drops below 2', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        // Simulate inactivity by backdating joinedAt past the kick threshold.
        await memberRepo.update({ address: 'bc1qbob' }, { joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
        await service.removeMember(group.id, 'bc1qbob', adminToken);
        const updated: any = await groupRepo.findOneBy({ id: group.id });
        expect(updated.active).toBe(false);
    });

    it('rejects adding an address already in another group', async () => {
        const { group: g1, adminToken: t1 } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(g1.id, 'bc1qbob', t1);
        const { group: g2, adminToken: t2 } = await service.createGroup('group-two', 'bc1qcharlie');
        await expect(service.addMember(g2.id, 'bc1qbob', t2))
            .rejects.toMatchObject({ code: 'address-in-group' });
    });

    it('populates address cache after membership changes', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        expect(service.getGroupForAddress('bc1qbob')).toEqual({ groupId: group.id, active: true });
    });

    it('cache reflects inactive state when only one member remains', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        await memberRepo.update({ address: 'bc1qbob' }, { joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
        await service.removeMember(group.id, 'bc1qbob', adminToken);
        // Creator still present but group inactive
        expect(service.getGroupForAddress('bc1qalice')).toEqual({ groupId: group.id, active: false });
    });

    // ── Creator leave / transfer ────────────────────────────────

    it('blocks removeMember when target is the creator', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        await expect(service.removeMember(group.id, 'bc1qalice', adminToken))
            .rejects.toMatchObject({ code: 'creator-cannot-be-removed' });
    });

    it('transferCreator + then the old creator is removable after inactivity window', async () => {
        const { group, adminToken: oldToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', oldToken);
        const { adminToken: newToken } = await service.transferCreator(group.id, 'bc1qbob', oldToken);
        // Backdate alice's join so she's eligible for removal under the 14d gate.
        await memberRepo.update({ address: 'bc1qalice' }, { joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
        await service.removeMember(group.id, 'bc1qalice', newToken);
        const members = Array.from(memberRepo._rows.values()) as any[];
        expect(members.find(m => m.address === 'bc1qalice')).toBeUndefined();
    });

    it('transferCreator rotates admin token', async () => {
        const { group, adminToken: oldToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', oldToken);
        const { adminToken: newToken } = await service.transferCreator(group.id, 'bc1qbob', oldToken);
        expect(newToken).not.toBe(oldToken);
        // Old token no longer works
        await expect(service.requireAdminToken(group.id, oldToken))
            .rejects.toMatchObject({ code: 'invalid-token' });
        // New token works
        await expect(service.requireAdminToken(group.id, newToken)).resolves.toBeDefined();
    });

    it('transferCreator normalizes bech32 target address to lowercase', async () => {
        // Wallet / QR-code presentations sometimes upper-case bech32. Members
        // are stored normalized, and the cache looks them up normalized — so
        // a raw uppercase toAddress would both fail the member lookup AND
        // leave group.creatorAddress in the wrong case if it slipped past.
        const { group, adminToken: oldToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', oldToken);
        const { group: saved, adminToken: newToken } =
            await service.transferCreator(group.id, 'BC1QBOB', oldToken);
        expect(newToken).not.toBe(oldToken);
        expect(saved.creatorAddress).toBe('bc1qbob');

        // And the member role transfer actually took effect — bob is now
        // the creator, not still a plain member.
        const members = Array.from(memberRepo._rows.values()) as any[];
        expect(members.find(m => m.address === 'bc1qbob')?.role).toBe('creator');
        expect(members.find(m => m.address === 'bc1qalice')?.role).toBe('member');
    });

    it('transferCreator rejects empty or malformed target address', async () => {
        const { group, adminToken: oldToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', oldToken);
        await expect(service.transferCreator(group.id, '', oldToken))
            .rejects.toMatchObject({ code: 'invalid-address' });
        await expect(service.transferCreator(group.id, '   ', oldToken))
            .rejects.toMatchObject({ code: 'invalid-address' });
    });

    // ── updateRoundResetConfig ──────────────────────────────────

    /** Convenience: create a fresh group, return ids/token for the tests below. */
    async function freshGroup() {
        const r = await service.createGroup('cfg-group', 'bc1qalice');
        return { id: r.group.id, token: r.adminToken };
    }

    it('updateRoundResetConfig: requires admin token', async () => {
        const { id } = await freshGroup();
        await expect(service.updateRoundResetConfig(id, { intervalDays: 7 }, undefined))
            .rejects.toMatchObject({ code: 'missing-token' });
        await expect(service.updateRoundResetConfig(id, { intervalDays: 7 }, 'wrong'))
            .rejects.toMatchObject({ code: 'invalid-token' });
    });

    it('updateRoundResetConfig: full valid config persists + arms cron', async () => {
        const { id, token } = await freshGroup();
        const updated = await service.updateRoundResetConfig(id, {
            intervalDays: 7,
            hourLocal: 3,
            timezone: 'Europe/Berlin',
            finderBonusSats: '50000',
        }, token);
        expect(updated.roundResetIntervalDays).toBe(7);
        expect(updated.roundResetHourLocal).toBe(3);
        expect(updated.roundResetTimezone).toBe('Europe/Berlin');
        expect(updated.finderBonusSats).toBe(50000);
        expect(roundReset.applyConfig).toHaveBeenCalledWith(updated);
    });

    it('updateRoundResetConfig: clearing interval (=null) unschedules via applyConfig', async () => {
        const { id, token } = await freshGroup();
        await service.updateRoundResetConfig(id, {
            intervalDays: 7, hourLocal: 3, timezone: 'Europe/Berlin',
        }, token);
        roundReset.applyConfig.mockClear();
        const updated = await service.updateRoundResetConfig(id, { intervalDays: null }, token);
        expect(updated.roundResetIntervalDays).toBeNull();
        // applyConfig is the unschedule path too — it sees a null interval and tears down.
        expect(roundReset.applyConfig).toHaveBeenCalledTimes(1);
    });

    it('updateRoundResetConfig: validation — invalid interval', async () => {
        const { id, token } = await freshGroup();
        for (const v of [0, -1, 1.5, 366, 99999]) {
            await expect(service.updateRoundResetConfig(id, { intervalDays: v as any }, token))
                .rejects.toMatchObject({ code: 'invalid-interval' });
        }
    });

    it('updateRoundResetConfig: validation — invalid hour', async () => {
        const { id, token } = await freshGroup();
        for (const v of [-1, 24, 3.5, 99]) {
            await expect(service.updateRoundResetConfig(id, { hourLocal: v as any }, token))
                .rejects.toMatchObject({ code: 'invalid-hour' });
        }
    });

    it('updateRoundResetConfig: validation — invalid timezone', async () => {
        const { id, token } = await freshGroup();
        for (const v of ['', 'NOT_A_REAL_TZ', 'Mars/Olympus', null as any, 42 as any]) {
            await expect(service.updateRoundResetConfig(id, { timezone: v }, token))
                .rejects.toMatchObject({ code: 'invalid-timezone' });
        }
    });

    it('updateRoundResetConfig: validation — invalid bonus', async () => {
        const { id, token } = await freshGroup();
        // negative
        await expect(service.updateRoundResetConfig(id, { finderBonusSats: -1 }, token))
            .rejects.toMatchObject({ code: 'invalid-bonus' });
        // over the cap (1 BTC = 100M sats; we set 200M to exceed)
        await expect(service.updateRoundResetConfig(id, { finderBonusSats: '200000000' }, token))
            .rejects.toMatchObject({ code: 'invalid-bonus' });
        // garbage string
        await expect(service.updateRoundResetConfig(id, { finderBonusSats: 'not-a-number' }, token))
            .rejects.toMatchObject({ code: 'invalid-bonus' });
    });

    it('updateRoundResetConfig: incomplete-schedule when interval set but hour/tz missing', async () => {
        const { id, token } = await freshGroup();
        // Group starts with no hour/tz. Setting only interval should fail.
        await expect(service.updateRoundResetConfig(id, { intervalDays: 7 }, token))
            .rejects.toMatchObject({ code: 'incomplete-schedule' });
    });

    it('updateRoundResetConfig: PATCH semantics — undefined leaves columns alone', async () => {
        const { id, token } = await freshGroup();
        await service.updateRoundResetConfig(id, {
            intervalDays: 7, hourLocal: 3, timezone: 'Europe/Berlin', finderBonusSats: 100000,
        }, token);
        // Only update bonus; interval/hour/tz must stay.
        const updated = await service.updateRoundResetConfig(id, { finderBonusSats: 200000 }, token);
        expect(updated.roundResetIntervalDays).toBe(7);
        expect(updated.roundResetHourLocal).toBe(3);
        expect(updated.roundResetTimezone).toBe('Europe/Berlin');
        expect(updated.finderBonusSats).toBe(200000);
    });

    it('updateRoundResetConfig: bonus null clears to 0', async () => {
        const { id, token } = await freshGroup();
        await service.updateRoundResetConfig(id, {
            intervalDays: 7, hourLocal: 3, timezone: 'Europe/Berlin', finderBonusSats: 100000,
        }, token);
        const cleared = await service.updateRoundResetConfig(id, { finderBonusSats: null }, token);
        expect(cleared.finderBonusSats).toBe(0);
    });

    it('updateRoundResetConfig: bonus accepts string|number', async () => {
        const { id, token } = await freshGroup();
        const a = await service.updateRoundResetConfig(id, { finderBonusSats: '12345' }, token);
        expect(a.finderBonusSats).toBe(12345);
        const b = await service.updateRoundResetConfig(id, { finderBonusSats: 67890 }, token);
        expect(b.finderBonusSats).toBe(67890);
    });

    it('dissolveGroup: also unschedules the per-group cron', async () => {
        const { id, token } = await freshGroup();
        // Need ≥ 2 members so the group is "active" — not strictly required
        // for dissolveGroup but realistic.
        await service.addMember(id, 'bc1qbob', token);
        await service.dissolveGroup(id, token);
        expect(roundReset.unschedule).toHaveBeenCalledWith(id);
    });

});
