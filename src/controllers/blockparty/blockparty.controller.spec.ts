import { HttpException } from '@nestjs/common';

import { BlockpartyController } from './blockparty.controller';
import { BlockpartyService } from '../../services/blockparty.service';
import { BlockpartyInvitationService } from '../../services/blockparty-invitation.service';

// ── Shared mock-repo factory ────────────────────────────────────
// Mirrors the pattern used in blockparty.service.spec.ts so the controller
// exercises real service code paths against in-memory storage. Integration-
// style: error mapping, response shapes, header parsing all under test.

function createMockRepo<T extends { id?: any }>(target: string = 'unknown') {
    const rows = new Map<any, T>();
    let nextNumeric = 1;
    let nextUuid = 1;

    function matchesWhere(row: any, where: any): boolean {
        return Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && '_type' in (v as any)) {
                if ((v as any)._type === 'isNull') return row[k] == null;
            }
            return row[k] === v;
        });
    }

    return {
        _rows: rows,
        target,
        save: jest.fn(async (row: T) => {
            // Token-keyed table (invitations): use the token as the implicit primary key.
            const isTokenKeyed = target === 'invitation';
            if (isTokenKeyed) {
                rows.set((row as any).token, { ...(row as any) });
                return { ...(row as any) };
            }
            if (!(row as any).id) {
                (row as any).id = target === 'history' || target === 'member'
                    ? nextNumeric++
                    : 'uuid-' + (nextUuid++);
            }
            rows.set((row as any).id, { ...(row as any) });
            return { ...(row as any) };
        }),
        create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
        find: jest.fn(async (query?: any) => {
            const all = Array.from(rows.values());
            let out = all;
            if (query?.where) {
                const where = Array.isArray(query.where) ? query.where : [query.where];
                out = all.filter((row: any) => where.some((w: any) => matchesWhere(row, w)));
            }
            if (query?.order) {
                const [[k, dir]] = Object.entries(query.order);
                out = [...out].sort((a: any, b: any) => {
                    if (a[k] === b[k]) return 0;
                    const cmp = a[k] < b[k] ? -1 : 1;
                    return dir === 'DESC' ? -cmp : cmp;
                });
            }
            return out;
        }),
        findOne: jest.fn(async (query: any) => {
            const all = Array.from(rows.values());
            if (!query?.where) return null;
            return all.find((row: any) => matchesWhere(row, query.where)) ?? null;
        }),
        findOneBy: jest.fn(async (where: any) => {
            const all = Array.from(rows.values());
            return all.find((row: any) => matchesWhere(row, where)) ?? null;
        }),
        delete: jest.fn(async (where: any) => {
            for (const [id, row] of Array.from(rows.entries())) {
                if (matchesWhere(row, where)) rows.delete(id);
            }
        }),
        update: jest.fn(async (where: any, patch: any) => {
            let affected = 0;
            for (const row of Array.from(rows.values()) as any[]) {
                if (matchesWhere(row, where)) {
                    Object.assign(row, patch);
                    affected++;
                }
            }
            return { affected };
        }),
    };
}

function createMockConfig(overrides: Record<string, string | undefined> = {}) {
    return {
        get: jest.fn((key: string) => overrides[key]),
    };
}

async function build() {
    const groupRepo = createMockRepo('group');
    const memberRepo = createMockRepo('member');
    const historyRepo = createMockRepo('history');
    const invitationRepo = createMockRepo('invitation');

    const repoByTarget: Record<string, any> = {
        group: groupRepo,
        member: memberRepo,
        history: historyRepo,
        invitation: invitationRepo,
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
    (historyRepo as any).manager = manager;
    (invitationRepo as any).manager = manager;

    const config = createMockConfig({
        PPLNS_FEE_ADDRESS: 'bc1qfeeaddress',
        PPLNS_FEE_PERCENT: '2',
        PPLNS_MIN_PAYOUT_SATS: '5000',
    });

    const groupService = { getGroupForAddress: jest.fn(() => undefined) };
    const addressEmailService = {
        getVerified: jest.fn(async (address: string) => ({
            address, email: `${address}@verified.local`, verifiedAt: Date.now(),
            createdAt: Date.now(), updatedAt: Date.now(),
        })),
    };
    const blockpartyService = new BlockpartyService(
        groupRepo as any,
        memberRepo as any,
        historyRepo as any,
        config as any,
        groupService as any,
        addressEmailService as any,
    );
    await blockpartyService.onModuleInit();

    const emailService = {
        sendInvitation: jest.fn(async () => undefined),
    };
    const invitationConfig = createMockConfig({
        POOL_BASE_URL: 'https://pool.example',
    });
    const invitationService = new BlockpartyInvitationService(
        invitationRepo as any,
        blockpartyService,
        emailService as any,
        invitationConfig as any,
    );

    const controller = new BlockpartyController(blockpartyService, invitationService);
    return { controller, blockpartyService, invitationService, groupRepo, memberRepo, invitationRepo, groupService };
}

async function expectHttp(promise: Promise<any>, status: number, code?: string): Promise<HttpException> {
    let err: any;
    try {
        await promise;
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(status);
    if (code !== undefined) {
        expect((err as HttpException).getResponse()).toMatchObject({ code });
    }
    return err as HttpException;
}

describe('BlockpartyController', () => {

    // ── Create ─────────────────────────────────────────────────────

    it('POST / creates a draft and returns one-shot adminToken + poolFeePercent', async () => {
        const { controller } = await build();
        const res = await controller.create({
            name: 'rental', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        expect(res.adminToken).toMatch(/^BP-/);
        expect(res.poolFeePercent).toBe(2);
        expect(res.group.status).toBe('draft');
        expect(res.group.adminAddress).toBe('bc1qadmin');
    });

    it('POST / returns 400 for invalid percentBp', async () => {
        const { controller } = await build();
        await expectHttp(controller.create({
            name: 'rental', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 50,
        }), 400, 'invalid-percent');
    });

    it('POST / returns 409 when admin address already runs a Blockparty', async () => {
        const { controller } = await build();
        await controller.create({ name: 'first', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000 });
        await expectHttp(controller.create({
            name: 'second', adminAddress: 'bc1qadmin', adminEmail: 'x@y.z', adminPercentBp: 5000,
        }), 409, 'admin-address-taken');
    });

    // ── Member management ──────────────────────────────────────────

    it('POST /:id/members 401s on missing admin token', async () => {
        const { controller } = await build();
        const { group: { id } } = (await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        })) as any;
        await expectHttp(controller.addMember(id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, undefined), 401, 'missing-token');
    });

    it('POST /:id/members mints an invitation token and surfaces it once', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const res = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);
        expect(res.inviteToken).toBeDefined();
        expect(res.inviteToken.length).toBeGreaterThan(20);
        expect(res.member.confirmed).toBe(false);
        expect(res.member.email).toMatch(/^b\*+@/); // masked
    });

    it('POST /:id/members 409s when address is in PPLNS group', async () => {
        const { controller, groupService } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        (groupService.getGroupForAddress as jest.Mock).mockImplementation(
            (addr: string) => addr === 'bc1qbob' ? { groupId: 'pp-1', active: true } : undefined,
        );
        await expectHttp(controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken), 409, 'address-in-pplns-group');
    });

    // ── State machine + splits ────────────────────────────────────

    it('POST /:id/transition-confirming 400s on bad splits sum and 200s when fixed', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4000, // 5000+4000=9000, need 10000
        }, created.adminToken);
        await expectHttp(
            controller.transitionToConfirming(created.group.id, created.adminToken),
            400, 'invalid-splits-sum',
        );

        // Fix the split via PATCH
        await controller.updateSplits(created.group.id, {
            splits: [
                { address: 'bc1qadmin', percentBp: 5000 },
                { address: 'bc1qbob', percentBp: 5000 },
            ],
        }, created.adminToken);

        const res = await controller.transitionToConfirming(created.group.id, created.adminToken);
        expect(res.status).toBe('confirming');
    });

    // ── Invitation flow ───────────────────────────────────────────

    it('full happy-path: create → addMember → invite-view → accept → READY', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@example.com', percentBp: 5000,
        }, created.adminToken);

        await controller.transitionToConfirming(created.group.id, created.adminToken);

        // Recipient hits the public invite endpoint — sees the full splits
        // with bob's email un-masked (he's the recipient) and the others masked.
        const view = await controller.getInvitation(added.inviteToken);
        expect(view.status).toBe('pending');
        expect(view.members).toHaveLength(2);
        expect(view.members.find((m: any) => m.address === 'bc1qbob')?.percentBp).toBe(5000);

        await controller.acceptInvitation(added.inviteToken);

        const detail = await controller.getDetail(created.group.id);
        expect(detail.status).toBe('ready');
        expect(detail.members.find((m: any) => m.address === 'bc1qbob')?.confirmed).toBe(true);
    });

    it('POST /invite/:token/accept 404s for unknown token', async () => {
        const { controller } = await build();
        await expectHttp(
            controller.acceptInvitation('does-not-exist-token'),
            404, 'invitation-not-found',
        );
    });

    it('POST /invite/:token/decline transitions the invitation and 409s on second call', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);

        await controller.declineInvitation(added.inviteToken);
        await expectHttp(
            controller.acceptInvitation(added.inviteToken),
            409, 'invitation-not-pending',
        );
    });

    it('GET /invite/:token marks expired invitations as expired in the view', async () => {
        const { controller, invitationRepo } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);

        // Backdate expiresAt by mutating the in-memory row.
        const invitation = Array.from((invitationRepo as any)._rows.values())[0] as any;
        invitation.expiresAt = Date.now() - 1000;

        const view = await controller.getInvitation(added.inviteToken);
        expect(view.status).toBe('expired');
    });

    // ── Dissolve ──────────────────────────────────────────────────

    it('POST /:id/dissolve from DRAFT succeeds without cooldown', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const res = await controller.dissolve(created.group.id, created.adminToken);
        expect(res).toEqual({ ok: true });

        const detail = await controller.getDetail(created.group.id);
        expect(detail.status).toBe('dissolved');
    });

    it('POST /:id/dissolve 403s when called during the 24h post-share cooldown', async () => {
        const { controller, blockpartyService } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);
        await controller.transitionToConfirming(created.group.id, created.adminToken);
        await controller.acceptInvitation(added.inviteToken);
        await blockpartyService.onShareAccepted('bc1qadmin');

        await expectHttp(
            controller.dissolve(created.group.id, created.adminToken),
            403, 'dissolve-cooldown',
        );
    });

    // ── by-address lookup ────────────────────────────────────────

    // ── Member-token + re-confirm + member-view ─────────────────────

    it('POST /invite/:token/accept returns a one-shot memberToken on first accept', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);

        const res: any = await controller.acceptInvitation(added.inviteToken);
        expect(res.memberToken).toBeDefined();
        expect(res.memberToken).toMatch(/^BPM-/);

        // Re-accepting the same invitation is now blocked (status='accepted'),
        // but the token is persistent — verified via reconfirm below.
        await expect(controller.acceptInvitation(added.inviteToken))
            .rejects.toMatchObject({ getStatus: expect.any(Function) });
    });

    it('reconfirm uses persistent memberToken after admin %-edit resets confirmedAt', async () => {
        const { controller, memberRepo } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);
        const acc: any = await controller.acceptInvitation(added.inviteToken);
        const bobMemberToken = acc.memberToken;

        // Admin edits splits → all confirmations reset.
        await controller.updateSplits(created.group.id, {
            splits: [
                { address: 'bc1qadmin', percentBp: 5000 },
                { address: 'bc1qbob', percentBp: 4800 },
            ],
        }, created.adminToken);

        // Bob's confirmedAt now null.
        let bob = Array.from((memberRepo as any)._rows.values()).find((m: any) => m.address === 'bc1qbob') as any;
        expect(bob.confirmedAt).toBeNull();

        // Bob re-confirms with his persistent token — no fresh invite cycle.
        await controller.reconfirmMember(created.group.id, 'bc1qbob', bobMemberToken);
        bob = Array.from((memberRepo as any)._rows.values()).find((m: any) => m.address === 'bc1qbob') as any;
        expect(bob.confirmedAt).toBeGreaterThan(0);
    });

    it('reconfirm 401s on missing or wrong memberToken', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, created.adminToken);
        await controller.acceptInvitation(added.inviteToken);

        await expectHttp(controller.reconfirmMember(created.group.id, 'bc1qbob', undefined), 401, 'missing-member-token');
        await expectHttp(controller.reconfirmMember(created.group.id, 'bc1qbob', 'BPM-totally-wrong-token-xx-padding-1234567890'), 401, 'invalid-member-token');
    });

    it('memberView returns un-masked email for the requesting member and masked for others', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'admin@host.tld', adminPercentBp: 5000,
        });
        // Email field on the body is now ignored by the service — the
        // binding email always wins (mock returns `${address}@verified.local`).
        const added = await controller.addMember(created.group.id, {
            address: 'bc1qbob', percentBp: 5000,
        }, created.adminToken);
        const acc: any = await controller.acceptInvitation(added.inviteToken);

        const view: any = await controller.memberView(created.group.id, 'bc1qbob', acc.memberToken);
        const bobRow = view.members.find((m: any) => m.address === 'bc1qbob');
        const adminRow = view.members.find((m: any) => m.address === 'bc1qadmin');
        expect(bobRow.email).toBe('bc1qbob@verified.local');
        expect(adminRow.email).not.toBe('admin@host.tld');
        expect(adminRow.email).toMatch(/\*/);
    });

    // ── Batch invitations ────────────────────────────────────────────

    it('POST /:id/members/batch processes multiple invites and surfaces per-row errors', async () => {
        const { controller, groupService } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 4000,
        });
        // bc1qbad is "in a PPLNS group" — must fail with address-in-pplns-group.
        (groupService.getGroupForAddress as jest.Mock).mockImplementation(
            (addr: string) => addr === 'bc1qbad' ? { groupId: 'pp-1', active: true } : undefined,
        );

        const res: any = await controller.addMembersBatch(created.group.id, {
            members: [
                { address: 'bc1qbob', email: 'bob@b.c', percentBp: 3000 },
                { address: 'bc1qcarol', email: 'c@d.e', percentBp: 2800 },
                { address: 'bc1qbad', email: 'x@y.z', percentBp: 0 }, // collision
            ],
        }, created.adminToken);

        expect(res.results).toHaveLength(3);
        expect(res.results[0]).toMatchObject({ address: 'bc1qbob', ok: true });
        expect(res.results[1]).toMatchObject({ address: 'bc1qcarol', ok: true });
        expect(res.results[2]).toMatchObject({ address: 'bc1qbad', ok: false });
        expect((res.results[2] as any).code).toBeDefined();
    });

    // ── Rental-provider hint ─────────────────────────────────────────

    it('PATCH /:id/rental-hint persists trimmed value, exposed in public view', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });

        const res: any = await controller.updateRentalHint(created.group.id, { hint: '  MRR  ' }, created.adminToken);
        expect(res.rentalProviderHint).toBe('MRR');

        const detail: any = await controller.getDetail(created.group.id);
        expect(detail.rentalProviderHint).toBe('MRR');

        // Clearing via null
        await controller.updateRentalHint(created.group.id, { hint: null }, created.adminToken);
        const cleared: any = await controller.getDetail(created.group.id);
        expect(cleared.rentalProviderHint).toBeNull();
    });

    // ── by-address ───────────────────────────────────────────────────

    it('GET /by-address/:address surfaces role + status for a member', async () => {
        const { controller } = await build();
        const created = await controller.create({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const adminRes = await controller.getByAddress('bc1qadmin');
        expect(adminRes).toMatchObject({ groupId: created.group.id, role: 'admin', status: 'draft' });

        const nobodyRes = await controller.getByAddress('bc1qnobody');
        expect(nobodyRes).toEqual({ groupId: null });
    });
});
