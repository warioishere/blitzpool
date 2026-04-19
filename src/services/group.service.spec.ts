jest.mock('node-telegram-bot-api', () => jest.fn());

import { GroupService, GroupServiceError } from './group.service';

// ── Mock Repos ──────────────────────────────────────────────────

function createMockRepo<T extends { id?: any }>() {
    const rows = new Map<any, T>();
    let nextNumeric = 1;

    return {
        _rows: rows,
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
    let service: GroupService;

    beforeEach(async () => {
        groupRepo = createMockRepo();
        memberRepo = createMockRepo();
        service = new GroupService(groupRepo as any, memberRepo as any);
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
        await service.selfLeave(group.id, 'bc1qbob');
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
        await service.selfLeave(group.id, 'bc1qbob');
        // Creator still present but group inactive
        expect(service.getGroupForAddress('bc1qalice')).toEqual({ groupId: group.id, active: false });
    });

    // ── Creator leave / transfer ────────────────────────────────

    it('blocks creator self-leave', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        await expect(service.selfLeave(group.id, 'bc1qalice'))
            .rejects.toMatchObject({ code: 'creator-cannot-self-leave' });
    });

    it('auto-transfers creator role to oldest member when creator is kicked by token', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.addMember(group.id, 'bc1qbob', adminToken);
        await service.addMember(group.id, 'bc1qcharlie', adminToken);
        await service.removeMember(group.id, 'bc1qalice', adminToken);

        const members = Array.from(memberRepo._rows.values()) as any[];
        const creator = members.find(m => m.role === 'creator');
        expect(creator.address).toBe('bc1qbob'); // oldest remaining
    });

    it('dissolves group when last creator leaves alone', async () => {
        const { group, adminToken } = await service.createGroup('group-one', 'bc1qalice');
        await service.removeMember(group.id, 'bc1qalice', adminToken);
        const updated: any = await groupRepo.findOneBy({ id: group.id });
        expect(updated.dissolvedAt).toBeDefined();
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
});
