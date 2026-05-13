jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsGroupJoinRequestService, JoinRequestServiceError } from './pplns-group-join-request.service';

function makeRepo<T>() {
    const rows: T[] = [];
    const repo: any = {
        rows,
        save: jest.fn(async (row: T) => {
            const idx = (rows as any[]).findIndex((r: any) =>
                ('id' in (row as any) && r.id === (row as any).id),
            );
            if (idx >= 0) {
                rows[idx] = { ...(rows[idx] as any), ...(row as any) };
                return rows[idx];
            }
            const withId = { id: (row as any).id ?? `id-${rows.length + 1}`, ...(row as any) };
            rows.push(withId);
            return withId;
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async (opts?: any) => {
            if (!opts?.where) return [...rows];
            return (rows as any[]).filter((r) =>
                Object.entries(opts.where).every(([k, v]) => r[k] === v),
            );
        }),
        findOneBy: jest.fn(async (where: any) => {
            return (rows as any[]).find((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
        }),
        findOne: jest.fn(async (opts: any) => {
            const where = opts.where ?? {};
            const matches = (rows as any[]).filter((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            );
            if (opts.order?.decidedAt === 'DESC') {
                matches.sort((a, b) => (b.decidedAt?.getTime?.() ?? 0) - (a.decidedAt?.getTime?.() ?? 0));
            } else if (opts.order?.createdAt === 'DESC') {
                matches.sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0));
            }
            return matches[0] ?? null;
        }),
        count: jest.fn(async (opts: any) => {
            if (!opts?.where) return rows.length;
            return (rows as any[]).filter((r) =>
                Object.entries(opts.where).every(([k, v]) => r[k] === v),
            ).length;
        }),
        update: jest.fn(async () => ({ affected: 0 })),
    };
    return repo;
}

function makeService(opts: { groupPublic?: boolean; groupDissolved?: boolean } = {}) {
    const requestRepo = makeRepo<any>();
    const memberRepo = makeRepo<any>();
    const groupService: any = {
        getGroup: jest.fn(async (id: string) => ({
            id,
            name: 'Friends',
            creatorAddress: 'bc1qadmin',
            isPublic: opts.groupPublic !== false,
            dissolvedAt: opts.groupDissolved ? new Date() : null,
        })),
        requireAdminToken: jest.fn(async (groupId: string, token: string | undefined) => {
            if (!token) throw new (require('./group.service').GroupServiceError)('missing-token', 'no token');
            if (token !== 'good-token') throw new (require('./group.service').GroupServiceError)('invalid-token', 'bad');
            return {
                id: groupId,
                name: 'Friends',
                creatorAddress: 'bc1qadmin',
                isPublic: opts.groupPublic !== false,
                dissolvedAt: opts.groupDissolved ? new Date() : null,
            };
        }),
        addMemberWithoutAdmin: jest.fn(async (groupId: string, address: string) => {
            const m = { groupId, address, role: 'member', joinedAt: Date.now() };
            memberRepo.rows.push(m);
            return m;
        }),
    };
    const addressEmailService: any = {
        _verified: new Map<string, any>(),
        getVerified: jest.fn(async (address: string) => {
            return addressEmailService._verified.get(address) ?? null;
        }),
        _setVerified: (address: string, email: string) => {
            addressEmailService._verified.set(address, { address, email, verifiedAt: Date.now() });
        },
    };
    const emailService: any = {
        sendJoinRequestApproved: jest.fn(async () => undefined),
        sendJoinRequestRejected: jest.fn(async () => undefined),
    };
    const config: any = {
        get: jest.fn((key: string) => {
            if (key === 'POOL_BASE_URL') return 'https://blitzpool.test';
            return undefined;
        }),
    };
    const service = new PplnsGroupJoinRequestService(
        requestRepo as any,
        memberRepo as any,
        groupService,
        addressEmailService,
        emailService,
        config,
    );
    return { service, requestRepo, memberRepo, groupService, addressEmailService, emailService };
}

describe('PplnsGroupJoinRequestService', () => {

    it('createJoinRequest: rejects when group is private', async () => {
        const { service, addressEmailService } = makeService({ groupPublic: false });
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        await expect(service.createJoinRequest('g1', 'bc1qbob', null))
            .rejects.toMatchObject({ code: 'not-found' });
    });

    it('createJoinRequest: rejects unverified address', async () => {
        const { service } = makeService();
        await expect(service.createJoinRequest('g1', 'bc1qbob', null))
            .rejects.toMatchObject({ code: 'email-not-verified' });
    });

    it('createJoinRequest: rejects bad address shape', async () => {
        const { service } = makeService();
        await expect(service.createJoinRequest('g1', '', null))
            .rejects.toMatchObject({ code: 'invalid-address' });
    });

    it('createJoinRequest: rejects address already in another group', async () => {
        const { service, addressEmailService, memberRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        memberRepo.rows.push({ groupId: 'other', address: 'bc1qbob', role: 'member' });
        await expect(service.createJoinRequest('g1', 'bc1qbob', null))
            .rejects.toMatchObject({ code: 'address-in-group' });
    });

    it('createJoinRequest: succeeds, snapshots email + truncates message', async () => {
        const { service, addressEmailService, requestRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const longMsg = 'x'.repeat(1000);
        const r = await service.createJoinRequest('g1', 'bc1qbob', longMsg);
        expect(r.email).toBe('bob@example.com');
        expect((r.message ?? '').length).toBe(500);
        expect(requestRepo.rows).toHaveLength(1);
    });

    it('createJoinRequest: rejects when over global pending cap', async () => {
        const { service, addressEmailService, requestRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        // Pre-seed 10 pending rows for this address.
        for (let i = 0; i < 10; i++) {
            requestRepo.rows.push({
                id: `r${i}`, groupId: `g${i}`, address: 'bc1qbob',
                email: 'bob@example.com', status: 'pending', createdAt: Date.now(),
            });
        }
        await expect(service.createJoinRequest('g11', 'bc1qbob', null))
            .rejects.toMatchObject({ code: 'too-many-pending' });
    });

    it('createJoinRequest: enforces 24h cooldown after a reject', async () => {
        const { service, addressEmailService, requestRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        requestRepo.rows.push({
            id: 'r-rej', groupId: 'g1', address: 'bc1qbob',
            email: 'bob@example.com', status: 'rejected',
            createdAt: new Date(Date.now() - 60_000),
            decidedAt: new Date(Date.now() - 60_000), // just rejected
        });
        await expect(service.createJoinRequest('g1', 'bc1qbob', null))
            .rejects.toMatchObject({ code: 'reject-cooldown' });
    });

    it('createJoinRequest: cooldown lifts after 24h', async () => {
        const { service, addressEmailService, requestRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        requestRepo.rows.push({
            id: 'r-rej', groupId: 'g1', address: 'bc1qbob',
            email: 'bob@example.com', status: 'rejected',
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            decidedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        });
        const r = await service.createJoinRequest('g1', 'bc1qbob', null);
        expect(r.status).toBe('pending');
    });

    it('approveRequest: requires admin token', async () => {
        const { service, requestRepo, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createJoinRequest('g1', 'bc1qbob', null);
        await expect(service.approveRequest('g1', r.id, 'wrong-token'))
            .rejects.toMatchObject({ code: 'invalid-token' });
        expect(requestRepo.rows[0].status).toBe('pending');
    });

    it('approveRequest: creates membership + sends email + marks decided', async () => {
        const { service, requestRepo, memberRepo, emailService, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createJoinRequest('g1', 'bc1qbob', 'hi');
        await service.approveRequest('g1', r.id, 'good-token');
        expect(memberRepo.rows.find((m: any) => m.address === 'bc1qbob')).toBeTruthy();
        expect(requestRepo.rows[0].status).toBe('approved');
        expect(requestRepo.rows[0].decidedAt).toBeTruthy();
        expect(emailService.sendJoinRequestApproved).toHaveBeenCalledTimes(1);
    });

    it('rejectRequest: marks decided + sends email, no membership created', async () => {
        const { service, requestRepo, memberRepo, emailService, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createJoinRequest('g1', 'bc1qbob', 'hi');
        await service.rejectRequest('g1', r.id, 'good-token');
        expect(requestRepo.rows[0].status).toBe('rejected');
        expect(requestRepo.rows[0].decidedAt).toBeTruthy();
        expect(memberRepo.rows).toHaveLength(0);
        expect(emailService.sendJoinRequestRejected).toHaveBeenCalledTimes(1);
    });

    it('approveRequest on missing/already-decided id returns not-found', async () => {
        const { service, requestRepo, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createJoinRequest('g1', 'bc1qbob', null);
        await service.approveRequest('g1', r.id, 'good-token');
        // second approve on the now-approved row 404s
        await expect(service.approveRequest('g1', r.id, 'good-token'))
            .rejects.toMatchObject({ code: 'not-found' });
        expect(requestRepo.rows[0].status).toBe('approved');
    });

    it('approveRequest fails when address joined another group between submit + approve', async () => {
        const { service, requestRepo, memberRepo, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createJoinRequest('g1', 'bc1qbob', null);
        // User joins another group via a different mechanism
        memberRepo.rows.push({ groupId: 'g2', address: 'bc1qbob', role: 'member' });
        await expect(service.approveRequest('g1', r.id, 'good-token'))
            .rejects.toMatchObject({ code: 'address-in-group' });
        // Request marked rejected so it doesn't keep showing as pending.
        expect(requestRepo.rows[0].status).toBe('rejected');
    });

    it('listForAddress filters out dissolved groups', async () => {
        const { service, requestRepo, addressEmailService, groupService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        await service.createJoinRequest('g1', 'bc1qbob', null);
        // Dissolve g1 — pending request should not surface.
        groupService.getGroup = jest.fn(async (id: string) => ({
            id, name: 'Friends', creatorAddress: 'bc1qadmin',
            isPublic: true, dissolvedAt: Date.now(),
        }));
        const list = await service.listForAddress('bc1qbob');
        expect(list).toHaveLength(0);
        expect(requestRepo.rows[0].status).toBe('pending'); // still pending in DB
    });
});
