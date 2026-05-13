jest.mock('node-telegram-bot-api', () => jest.fn());

import { PplnsGroupInvitationService, InvitationServiceError } from './pplns-group-invitation.service';

function makeRepo<T>() {
    const rows: T[] = [];
    const repo: any = {
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
        update: jest.fn(async (where: any, patch: any) => {
            let affected = 0;
            for (const r of rows as any[]) {
                if (Object.entries(where).every(([k, v]) => {
                    if (v && typeof v === 'object' && (v as any)._type === 'lessThan') {
                        return r[k]?.getTime?.() < (v as any)._value?.getTime?.();
                    }
                    return r[k] === v;
                })) {
                    Object.assign(r, patch);
                    affected += 1;
                }
            }
            return { affected };
        }),
    };
    // .manager.transaction(cb) shim — runs the callback against the same
    // repo instance (no real isolation needed in tests).
    repo.manager = {
        transaction: jest.fn(async (cb: any) => {
            return cb({ getRepository: () => repo });
        }),
    };
    return repo;
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
        expect(typeof r.expiresAt).toBe('number');
        expect(r.expiresAt).toBeGreaterThan(Date.now());

        expect(emailService.sendInvitation).toHaveBeenCalledTimes(1);
        const sent = (emailService.sendInvitation as jest.Mock).mock.calls[0][0];
        expect(sent.to).toBe('bob@example.com');
        expect(sent.address).toBe('bc1qbob');
        // Single inviteUrl pointing at the UI invite page — no automatic
        // accept/decline URL anymore, the user confirms on the page.
        // Hash routing: path lives in the fragment, hence /#/invite/<token>.
        expect(sent.inviteUrl).toContain('https://blitzpool.test/#/invite/');

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

    it('accept fails when the group has been dissolved between invite and accept', async () => {
        const { service, addressEmailService, groupService, memberRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createInvitation('g1', 'bc1qbob', 'good-token');

        // Admin dissolves the group after the invite but before the accept.
        groupService.getGroup = jest.fn(async (id: string) => ({
            id, name: 'Friends', creatorAddress: 'bc1qadmin',
            dissolvedAt: new Date(),
        }));

        await expect(service.accept(r.token)).rejects.toMatchObject({ code: 'group-dissolved' });
        expect(memberRepo.rows).toHaveLength(0);
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
            inviteType: 'directed',
            createdAt: new Date(Date.now() - 100_000),
            expiresAt: new Date(Date.now() - 1000),
        });

        const list = await service.listPendingForAddress('bc1qbob');
        expect(list).toHaveLength(1);
        // Sanity: the response is the non-expired one (we can tell by the groupId).
        expect(list[0].groupId).toBe('g1');
        // The token is deliberately NOT in the response — this endpoint serves
        // the public dashboard banner, and leaking the token would let any
        // visitor of /app/:address accept the invitation on the recipient's
        // behalf. Reference r1.token to avoid an unused-binding complaint.
        expect(r1.token).toBeTruthy();
    });

    // ── Open invitation links ───────────────────────────────────────

    it('createOpenInvite: rejects bad admin token', async () => {
        const { service } = makeService();
        await expect(service.createOpenInvite('g1', '24h', 'bad-token'))
            .rejects.toMatchObject({ code: 'invalid-token' });
    });

    it('createOpenInvite: rejects unknown TTL preset', async () => {
        const { service } = makeService();
        await expect(service.createOpenInvite('g1', 'forever' as any, 'good-token'))
            .rejects.toMatchObject({ code: 'invalid-ttl' });
    });

    it('createOpenInvite: persists row with inviteType=open + null address/email', async () => {
        const { service, invitationRepo } = makeService();
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        expect(r.token).toBeTruthy();
        expect(r.expiresAt).toBeGreaterThan(Date.now());

        expect(invitationRepo.rows).toHaveLength(1);
        const row = invitationRepo.rows[0];
        expect(row.inviteType).toBe('open');
        expect(row.address).toBeNull();
        expect(row.email).toBeNull();
        expect(row.status).toBe('pending');
    });

    it('createOpenInvite: replaces previous active link (atomic revoke)', async () => {
        const { service, invitationRepo } = makeService();
        const r1 = await service.createOpenInvite('g1', '24h', 'good-token');
        const r2 = await service.createOpenInvite('g1', '7d', 'good-token');
        expect(r2.token).not.toBe(r1.token);

        const old = invitationRepo.rows.find((r: any) => r.token === r1.token);
        const fresh = invitationRepo.rows.find((r: any) => r.token === r2.token);
        expect(old.status).toBe('revoked');
        expect(fresh.status).toBe('pending');
    });

    it('getActiveOpenInvite: returns null when none, returns latest when active', async () => {
        const { service } = makeService();
        const empty = await service.getActiveOpenInvite('g1', 'good-token');
        expect(empty).toBeNull();

        const r = await service.createOpenInvite('g1', '7d', 'good-token');
        const active = await service.getActiveOpenInvite('g1', 'good-token');
        expect(active?.token).toBe(r.token);
    });

    it('getActiveOpenInvite: returns null when current link is past TTL', async () => {
        const { service, invitationRepo } = makeService();
        const r = await service.createOpenInvite('g1', '1h', 'good-token');
        const row = invitationRepo.rows.find((x: any) => x.token === r.token);
        row.expiresAt = new Date(Date.now() - 1000);
        const active = await service.getActiveOpenInvite('g1', 'good-token');
        expect(active).toBeNull();
    });

    it('revokeOpenInvite: marks current pending link as revoked; idempotent', async () => {
        const { service, invitationRepo } = makeService();
        await service.createOpenInvite('g1', '24h', 'good-token');
        await service.revokeOpenInvite('g1', 'good-token');
        expect(invitationRepo.rows[0].status).toBe('revoked');
        // Second call is a no-op (no pending rows left).
        await service.revokeOpenInvite('g1', 'good-token');
        expect(invitationRepo.rows[0].status).toBe('revoked');
    });

    it('getOpenInvitePublic: returns group context for valid token', async () => {
        const { service } = makeService();
        const r = await service.createOpenInvite('g1', '7d', 'good-token');
        const info = await service.getOpenInvitePublic(r.token);
        expect(info?.groupId).toBe('g1');
        expect(info?.groupName).toBe('Friends');
        expect(info?.token).toBe(r.token);
    });

    it('getOpenInvitePublic: returns null for revoked / expired / unknown / dissolved', async () => {
        const { service, invitationRepo, groupService } = makeService();
        // Unknown
        expect(await service.getOpenInvitePublic('nope')).toBeNull();
        // Revoked
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        await service.revokeOpenInvite('g1', 'good-token');
        expect(await service.getOpenInvitePublic(r.token)).toBeNull();
        // Expired
        await service.createOpenInvite('g1', '1h', 'good-token');
        const last = invitationRepo.rows[invitationRepo.rows.length - 1];
        last.expiresAt = new Date(Date.now() - 1000);
        expect(await service.getOpenInvitePublic(last.token)).toBeNull();
        // Group dissolved
        await service.createOpenInvite('g1', '7d', 'good-token');
        const live = invitationRepo.rows[invitationRepo.rows.length - 1];
        groupService.getGroup = jest.fn(async (id: string) => ({
            id, name: 'Friends', creatorAddress: 'bc1qadmin', dissolvedAt: new Date(),
        }));
        expect(await service.getOpenInvitePublic(live.token)).toBeNull();
    });

    it('acceptOpenInvite: rejects address with no verified email', async () => {
        const { service } = makeService();
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        await expect(service.acceptOpenInvite(r.token, 'bc1qcarol'))
            .rejects.toMatchObject({ code: 'email-not-verified' });
    });

    it('acceptOpenInvite: rejects bad address shape', async () => {
        const { service } = makeService();
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        await expect(service.acceptOpenInvite(r.token, ''))
            .rejects.toMatchObject({ code: 'invalid-address' });
    });

    it('acceptOpenInvite: creates membership and leaves link reusable', async () => {
        const { service, addressEmailService, memberRepo, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        addressEmailService._setVerified('bc1qcarol', 'carol@example.com');

        const r = await service.createOpenInvite('g1', '7d', 'good-token');
        const m1 = await service.acceptOpenInvite(r.token, 'bc1qbob');
        expect(m1.address).toBe('bc1qbob');
        expect(memberRepo.rows).toHaveLength(1);
        // Link still pending — second user can also claim it.
        const row = invitationRepo.rows.find((x: any) => x.token === r.token);
        expect(row.status).toBe('pending');

        const m2 = await service.acceptOpenInvite(r.token, 'bc1qcarol');
        expect(m2.address).toBe('bc1qcarol');
        expect(memberRepo.rows).toHaveLength(2);
    });

    it('acceptOpenInvite: rejects when link is past TTL (and marks expired)', async () => {
        const { service, addressEmailService, invitationRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createOpenInvite('g1', '1h', 'good-token');
        const row = invitationRepo.rows.find((x: any) => x.token === r.token);
        row.expiresAt = new Date(Date.now() - 1000);

        await expect(service.acceptOpenInvite(r.token, 'bc1qbob'))
            .rejects.toMatchObject({ code: 'expired' });
        expect(row.status).toBe('expired');
    });

    it('acceptOpenInvite: rejects revoked link', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        await service.revokeOpenInvite('g1', 'good-token');
        await expect(service.acceptOpenInvite(r.token, 'bc1qbob'))
            .rejects.toMatchObject({ code: 'expired' });
    });

    it('directed-invite accept() refuses an open token (404)', async () => {
        const { service, addressEmailService } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        // Wrong endpoint — directed accept doesn't take an address.
        await expect(service.accept(r.token))
            .rejects.toMatchObject({ code: 'not-found' });
    });

    it('createOpenInvite: defaults approvalRequired=false when not passed', async () => {
        const { service, invitationRepo } = makeService();
        const r = await service.createOpenInvite('g1', '24h', 'good-token');
        expect(r.approvalRequired).toBe(false);
        expect(invitationRepo.rows[0].approvalRequired).toBe(false);
    });

    it('createOpenInvite: persists approvalRequired=true when explicitly opted-in', async () => {
        const { service, invitationRepo } = makeService();
        const r = await service.createOpenInvite('g1', '24h', 'good-token', true);
        expect(r.approvalRequired).toBe(true);
        expect(invitationRepo.rows[0].approvalRequired).toBe(true);
    });

    it('getOpenInvitePublic: surfaces approvalRequired so the frontend can branch', async () => {
        const { service } = makeService();
        const auto = await service.createOpenInvite('g1', '7d', 'good-token', false);
        const approve = await service.createOpenInvite('g1', '7d', 'good-token', true);
        // Second create revoked the first; only the latest is publicly visible.
        expect(await service.getOpenInvitePublic(auto.token)).toBeNull();
        expect((await service.getOpenInvitePublic(approve.token))?.approvalRequired).toBe(true);
    });

    it('getActiveOpenInvite: surfaces approvalRequired to the admin UI', async () => {
        const { service } = makeService();
        await service.createOpenInvite('g1', '7d', 'good-token', true);
        const active = await service.getActiveOpenInvite('g1', 'good-token');
        expect(active?.approvalRequired).toBe(true);
    });

    it('acceptOpenInvite: refuses approvalRequired link with approval-required code', async () => {
        // Backend-enforced — a curl POST to /invitations/open/:token/accept
        // bypassing the frontend session must still get rejected so the
        // admin's vet-each-applicant intent can't be circumvented.
        const { service, addressEmailService, memberRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createOpenInvite('g1', '24h', 'good-token', true);

        await expect(service.acceptOpenInvite(r.token, 'bc1qbob'))
            .rejects.toMatchObject({ code: 'approval-required' });
        expect(memberRepo.rows).toHaveLength(0);
    });

    it('acceptOpenInvite: still auto-accepts when approvalRequired is false', async () => {
        const { service, addressEmailService, memberRepo } = makeService();
        addressEmailService._setVerified('bc1qbob', 'bob@example.com');
        const r = await service.createOpenInvite('g1', '24h', 'good-token', false);

        const member = await service.acceptOpenInvite(r.token, 'bc1qbob');
        expect(member.address).toBe('bc1qbob');
        expect(memberRepo.rows).toHaveLength(1);
    });
});
