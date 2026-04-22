jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsGroupInvitationService, InvitationServiceError } from './pplns-group-invitation.service';

function makeRepo<T>() {
    const rows: T[] = [];
    return {
        rows,
        save: jest.fn(async (row: T) => {
            const idx = (rows as any[]).findIndex((r: any) =>
                ('token' in (row as any) && r.token === (row as any).token) ||
                ('id' in (row as any) && r.id === (row as any).id),
            );
            if (idx >= 0) {
                rows[idx] = { ...(rows[idx] as any), ...(row as any) };
                return rows[idx];
            }
            rows.push({ ...(row as any) });
            return row;
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async (opts?: any) => {
            if (!opts?.where) return [...rows];
            const where = opts.where;
            return (rows as any[]).filter((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            );
        }),
        findOneBy: jest.fn(async (where: any) => {
            return (rows as any[]).find((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
        }),
        findOne: jest.fn(async (opts: any) => {
            const where = opts.where ?? {};
            return (rows as any[]).find((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null;
        }),
        delete: jest.fn(async (where: any) => {
            const before = rows.length;
            const remaining = (rows as any[]).filter((r) => {
                if (typeof where === 'string') return r.token !== where;
                return !Object.entries(where).every(([k, v]) => r[k] === v);
            });
            rows.length = 0;
            rows.push(...remaining as any);
            return { affected: before - rows.length };
        }),
        update: jest.fn(async () => ({ affected: 0 })),
    };
}

function makeService(opts: { emailEnabled?: boolean } = {}) {
    const invitationRepo = makeRepo<any>();
    const memberRepo = makeRepo<any>();
    const groupService = {
        requireAdminToken: jest.fn(async (groupId: string, token: string | undefined) => {
            if (!token) throw new (require('./group.service').GroupServiceError)('missing-token', 'no token');
            if (token !== 'good-token') throw new (require('./group.service').GroupServiceError)('invalid-token', 'bad');
            return { id: groupId, name: 'Friends', creatorAddress: 'bc1qadmin' };
        }),
        getGroup: jest.fn(async (id: string) => ({
            id, name: 'Friends', creatorAddress: 'bc1qadmin', dissolvedAt: null,
        })),
        addMemberWithoutAdmin: jest.fn(async (groupId: string, address: string) => {
            const existing = memberRepo.rows.find((m: any) => m.address === address);
            if (existing) throw new (require('./group.service').GroupServiceError)('address-in-group', 'already in another group');
            const m = { groupId, address, role: 'member', joinedAt: new Date() };
            memberRepo.rows.push(m);
            return m;
        }),
    };
    const addressEmailService = {
        getVerified: jest.fn(async (address: string) => {
            const verified = (addressEmailService as any)._verified.get(address);
            return verified ?? null;
        }),
        _verified: new Map<string, any>(),
        _setVerified: (address: string, email: string) => {
            (addressEmailService as any)._verified.set(address, { address, email, verifiedAt: new Date() });
        },
    };
    const emailService = {
        isEnabled: jest.fn(() => opts.emailEnabled !== false),
        sendInvitation: jest.fn(async () => undefined),
        sendVerification: jest.fn(async () => undefined),
    };
    const config = {
        get: jest.fn((key: string) => {
            if (key === 'POOL_BASE_URL') return 'https://blitzpool.test';
            return undefined;
        }),
    };
    const service = new PplnsGroupInvitationService(
        invitationRepo as any,
        memberRepo as any,
        groupService as any,
        addressEmailService as any,
        emailService as any,
        config as any,
    );
    return { service, invitationRepo, memberRepo, groupService, addressEmailService, emailService };
}

describe('PplnsGroupInvitationService', () => {

    it('createInvitation refuses if address has no verified email', async () => {
        const { service } = makeService();
        await expect(
            service.createInvitation('g1', 'bc1qbob', 'good-token'),
        ).rejects.toThrow(/email/i);
    });

    it('createInvitation succeeds when address has verified email + sends mail', async () => {
        const { service, addressEmailService, emailService, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');

        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');
        expect(r.email).toBe('bob@example.com');
        expect(r.token).toBeTruthy();
        expect(r.expiresAt).toBeInstanceOf(Date);

        expect(emailService.sendInvitation).toHaveBeenCalledTimes(1);
        const sent = (emailService.sendInvitation as jest.Mock).mock.calls[0][0];
        expect(sent.to).toBe('bob@example.com');
        expect(sent.address).toBe('bc1qbob');
        // Single inviteUrl pointing at the UI invite page — no automatic
        // accept/decline URL anymore, the user confirms on the page.
        expect(sent.inviteUrl).toContain('https://blitzpool.test/invite/');

        expect(invitationRepo.rows).toHaveLength(1);
        expect(invitationRepo.rows[0].status).toBe('pending');
    });

    it('createInvitation rejects bad admin token', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        await expect(
            service.createInvitation('g1', 'bc1qbob', 'wrong-token'),
        ).rejects.toMatchObject({ code: 'invalid-token' });
    });

    it('createInvitation refuses if invitation already pending', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        await service.createInvitation('g1', 'bc1qbob', 'good-token');
        await expect(
            service.createInvitation('g1', 'bc1qbob', 'good-token'),
        ).rejects.toThrow(/pending/i);
    });

    it('accept creates the membership', async () => {
        const { service, addressEmailService, memberRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        const member = await service.accept(r.token);
        expect(member.address).toBe('bc1qbob');
        expect(member.groupId).toBe('g1');
        expect(memberRepo.rows).toHaveLength(1);
    });

    it('accept twice is idempotent (second call returns same member)', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        const m1 = await service.accept(r.token);
        const m2 = await service.accept(r.token);
        expect(m1.address).toBe(m2.address);
    });

    it('accept fails on declined invitation', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        await service.decline(r.token);
        await expect(service.accept(r.token)).rejects.toThrow(/declined/i);
    });

    it('accept fails on expired invitation', async () => {
        const { service, addressEmailService, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        // Force expiry
        const row = invitationRepo.rows[0];
        row.expiresAt = new Date(Date.now() - 1000);

        await expect(service.accept(r.token)).rejects.toThrow(/expired/i);
        expect(invitationRepo.rows[0].status).toBe('expired');
    });

    it('decline marks invitation as declined; second accept fails', async () => {
        const { service, addressEmailService, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        await service.decline(r.token);
        expect(invitationRepo.rows[0].status).toBe('declined');
        await expect(service.accept(r.token)).rejects.toThrow();
    });

    it('listPendingForAddress returns only pending non-expired invitations', async () => {
        const { service, addressEmailService, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r1 = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        // Make it look like a different address has been invited too, but expired
        invitationRepo.rows.push({
            token: 'expired-token',
            groupId: 'g2',
            address: 'bc1qbob',
            email: 'bob@example.com',
            status: 'pending',
            createdAt: new Date(Date.now() - 100_000),
            expiresAt: new Date(Date.now() - 1000),
        });

        const list = await service.listPendingForAddress('bc1qbob');
        expect(list).toHaveLength(1);
        expect(list[0].token).toBe(r1.token);
    });
});
