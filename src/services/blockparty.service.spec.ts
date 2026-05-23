import { BlockpartyService, BlockpartyServiceError } from './blockparty.service';

// ── Mock Repos ──────────────────────────────────────────────────

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

const FEE_ADDR = 'bc1qfeeaddress';

async function buildService(envOverrides: Record<string, string | undefined> = {}) {
    const groupRepo = createMockRepo('group');
    const memberRepo = createMockRepo('member');
    const historyRepo = createMockRepo('history');

    const repoByTarget: Record<string, any> = {
        group: groupRepo,
        member: memberRepo,
        history: historyRepo,
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

    const config = createMockConfig({
        PPLNS_FEE_ADDRESS: FEE_ADDR,
        PPLNS_FEE_PERCENT: '2',
        PPLNS_MIN_PAYOUT_SATS: '5000',
        ...envOverrides,
    });

    const groupService = {
        // Default: address never in a PPLNS group. Individual tests can override.
        getGroupForAddress: jest.fn(() => undefined),
    };
    const addressEmailService = {
        // Default: every address has a verified binding. Tests that want
        // the email-not-verified failure path override this per-call.
        getVerified: jest.fn(async (address: string) => ({
            address, email: `${address}@verified.local`, verifiedAt: Date.now(),
            createdAt: Date.now(), updatedAt: Date.now(),
        })),
    };
    const service = new BlockpartyService(
        groupRepo as any,
        memberRepo as any,
        historyRepo as any,
        config as any,
        groupService as any,
        addressEmailService as any,
    );
    await service.onModuleInit();
    return { service, groupRepo, memberRepo, historyRepo, groupService, addressEmailService };
}

describe('BlockpartyService', () => {

    // ── Creation ────────────────────────────────────────────────

    it('creates a draft with admin as first member and returns a one-shot admin token', async () => {
        const { service, memberRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'rental-2026-05',
            adminAddress: 'bc1qadmin',
            adminEmail: 'admin@example.com',
            adminPercentBp: 5000,
        });

        expect(adminToken).toMatch(/^BP-/);
        expect(group.adminTokenHash).toBeDefined();
        expect(group.adminTokenHash).not.toBe(adminToken);
        expect(group.status).toBe('draft');
        expect(group.lastShareAt).toBeNull();

        const members = Array.from((memberRepo as any)._rows.values());
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({
            address: 'bc1qadmin',
            role: 'admin',
            percentBp: 5000,
        });
        expect((members[0] as any).confirmedAt).toBeGreaterThan(0);
    });

    it('rejects short or control-character names', async () => {
        const { service } = await buildService();
        await expect(service.createGroup({
            name: 'ab', adminAddress: 'bc1qa', adminEmail: 'a@b.c', adminPercentBp: 5000,
        })).rejects.toThrow(BlockpartyServiceError);
        await expect(service.createGroup({
            name: 'has\nnewline', adminAddress: 'bc1qa', adminEmail: 'a@b.c', adminPercentBp: 5000,
        })).rejects.toThrow(BlockpartyServiceError);
    });

    it('rejects out-of-range percentBp (< 1% or > 100%)', async () => {
        const { service } = await buildService();
        await expect(service.createGroup({
            name: 'pct-low', adminAddress: 'bc1qa', adminEmail: 'a@b.c', adminPercentBp: 50,
        })).rejects.toMatchObject({ code: 'invalid-percent' });
        await expect(service.createGroup({
            name: 'pct-high', adminAddress: 'bc1qa', adminEmail: 'a@b.c', adminPercentBp: 10001,
        })).rejects.toMatchObject({ code: 'invalid-percent' });
    });

    it('rejects duplicate admin address across blockparties', async () => {
        const { service } = await buildService();
        await service.createGroup({
            name: 'first', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await expect(service.createGroup({
            name: 'second', adminAddress: 'bc1qadmin', adminEmail: 'x@y.z', adminPercentBp: 5000,
        })).rejects.toMatchObject({ code: 'admin-address-taken' });
    });

    // ── Member management + state machine ──────────────────────────

    it('adds an unconfirmed member while in DRAFT', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const m = await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4800,
        }, adminToken);
        expect(m.confirmedAt).toBeNull();
        expect(m.role).toBe('member');
    });

    it('requires the admin token to add members', async () => {
        const { service } = await buildService();
        const { group } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await expect(service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4800,
        }, 'wrong-token')).rejects.toMatchObject({ code: 'invalid-token' });
    });

    it('refuses to add a member whose address already runs as admin', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await expect(service.addMember(group.id, {
            address: 'bc1qadmin', email: 'a@b.c', percentBp: 4800,
        }, adminToken)).rejects.toMatchObject({ code: 'admin-cannot-rejoin' });
    });

    it('refuses to remove the admin member', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await expect(service.removeMember(group.id, 'bc1qadmin', adminToken))
            .rejects.toMatchObject({ code: 'admin-cannot-be-removed' });
    });

    it('transitions DRAFT → CONFIRMING and READY ← when all members confirm', async () => {
        const { service, groupRepo, memberRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);

        // sum = 4900 + 4900 = 9800 = 10000 - 2% pool fee → valid
        await service.transitionToConfirming(group.id, adminToken);
        let saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('confirming');

        // After bob confirms, all members confirmed → READY
        await service.markMemberConfirmed(group.id, 'bc1qbob');
        saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('ready');

        // Spotcheck: bob's confirmedAt is set
        const bob = Array.from((memberRepo as any)._rows.values())
            .find((m: any) => m.address === 'bc1qbob') as any;
        expect(bob.confirmedAt).toBeGreaterThan(0);
    });

    it('rejects transitionToConfirming when splits do not sum to (10000 - feeBp)', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4000, // sum = 9000, expected 9800
        }, adminToken);
        await expect(service.transitionToConfirming(group.id, adminToken))
            .rejects.toMatchObject({ code: 'invalid-splits-sum' });
    });

    it('updateSplits resets ALL members confirmation timestamps and drops READY back to CONFIRMING', async () => {
        const { service, groupRepo, memberRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.transitionToConfirming(group.id, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');

        let saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('ready');

        await service.updateSplits(group.id, [
            { address: 'bc1qadmin', percentBp: 5800 },
            { address: 'bc1qbob', percentBp: 4000 },
        ], adminToken);

        saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('confirming');

        // New behavior: admin row keeps confirmedAt (its edit is its
        // implicit consent); non-admin members get reset and must
        // re-confirm with their member token.
        const all = Array.from((memberRepo as any)._rows.values()) as any[];
        const adminRow = all.find(m => m.address === 'bc1qadmin');
        const bobRow = all.find(m => m.address === 'bc1qbob');
        expect(adminRow.confirmedAt).toBeGreaterThan(0);
        expect(bobRow.confirmedAt).toBeNull();
    });

    // ── Share + block hooks ──────────────────────────────────────────

    it('onShareAccepted transitions READY → ACTIVE on first share and refreshes lastShareAt', async () => {
        const { service, groupRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.transitionToConfirming(group.id, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');

        const t0 = Date.now();
        await service.onShareAccepted('bc1qadmin');
        const saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('active');
        expect(saved.lastShareAt).toBeGreaterThanOrEqual(t0);
    });

    it('onShareAccepted is a no-op for non-admin addresses', async () => {
        const { service, groupRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.transitionToConfirming(group.id, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');

        await service.onShareAccepted('bc1qbob');
        const saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('ready');
        expect(saved.lastShareAt).toBeNull();
    });

    it('dissolve is blocked during the 7-day post-share cooldown', async () => {
        const { service, groupRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.transitionToConfirming(group.id, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');
        await service.onShareAccepted('bc1qadmin');

        await expect(service.dissolveGroup(group.id, adminToken))
            .rejects.toMatchObject({ code: 'dissolve-cooldown' });

        // Simulate 25h of silence and try again — should succeed.
        const saved = await (groupRepo as any).findOneBy({ id: group.id });
        saved.lastShareAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
        await (groupRepo as any).save(saved);

        await service.dissolveGroup(group.id, adminToken);
        const after = await (groupRepo as any).findOneBy({ id: group.id });
        expect(after.status).toBe('dissolved');
        expect(after.dissolvedAt).toBeGreaterThan(0);
    });

    it('dissolve from DRAFT skips the cooldown', async () => {
        const { service, groupRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.dissolveGroup(group.id, adminToken);
        const saved = await (groupRepo as any).findOneBy({ id: group.id });
        expect(saved.status).toBe('dissolved');
    });

    it('rejects edits once the party is ACTIVE (frozen forever)', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.transitionToConfirming(group.id, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');
        await service.onShareAccepted('bc1qadmin');

        await expect(service.addMember(group.id, {
            address: 'bc1qcarol', email: 'c@d.e', percentBp: 1000,
        }, adminToken)).rejects.toMatchObject({ code: 'not-editable' });

        await expect(service.updateSplits(group.id, [
            { address: 'bc1qadmin', percentBp: 5000 },
            { address: 'bc1qbob', percentBp: 4800 },
        ], adminToken)).rejects.toMatchObject({ code: 'not-editable' });
    });

    // ── Payout distribution ─────────────────────────────────────────

    it('getPayoutDistribution honours the per-member percentBp', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);

        const reward = 312_500_000;
        const dist = await service.getPayoutDistribution(group.id, reward);

        const baseFee = Math.floor(reward * 0.02);
        const minerCut = reward - baseFee;
        const expectAdmin = Math.floor(minerCut * 0.50);
        const expectBob = Math.floor(minerCut * 0.50);

        const adminEntry = dist.splits.find(s => s.address === 'bc1qadmin');
        const bobEntry = dist.splits.find(s => s.address === 'bc1qbob');
        expect(adminEntry?.sats).toBe(expectAdmin);
        expect(bobEntry?.sats).toBe(expectBob);

        // Total sats conserved.
        const totalOut = dist.payouts.reduce((acc, p) => acc + p.sats, 0);
        expect(totalOut).toBe(reward);
    });

    it('onBlockFound persists a history row with the splits snapshot', async () => {
        const { service, historyRepo } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);

        const reward = 312_500_000;
        const dist = await service.getPayoutDistribution(group.id, reward);

        const row = await service.onBlockFound({
            groupId: group.id,
            blockHeight: 900_000,
            blockHash: 'a'.repeat(64),
            coinbaseValueSats: reward,
        });

        expect(row).not.toBeNull();
        expect(row!.splits).toHaveLength(2);
        expect(row!.poolFeeSats).toBe(dist.poolFeeSats);
        expect((historyRepo as any)._rows.size).toBe(1);
    });

    // ── Mode-collision ─────────────────────────────────────────────

    it('refuses createGroup when the admin address is in a PPLNS group', async () => {
        const { service, groupService } = await buildService();
        (groupService.getGroupForAddress as jest.Mock).mockImplementation(
            (addr: string) => addr === 'bc1qadmin' ? { groupId: 'pp-1', active: true } : undefined,
        );
        await expect(service.createGroup({
            name: 'rental', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        })).rejects.toMatchObject({ code: 'address-in-pplns-group' });
    });

    it('refuses addMember when the candidate address has no verified email', async () => {
        const { service, addressEmailService } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        (addressEmailService.getVerified as jest.Mock).mockImplementation(
            async (addr: string) => addr === 'bc1qbob' ? null : { address: addr, email: `${addr}@v.l`, verifiedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() },
        );
        await expect(service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4800,
        }, adminToken)).rejects.toMatchObject({ code: 'email-not-verified' });
    });

    it('refuses addMember when the candidate address is in a PPLNS group', async () => {
        const { service, groupService } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        (groupService.getGroupForAddress as jest.Mock).mockImplementation(
            (addr: string) => addr === 'bc1qbob' ? { groupId: 'pp-1', active: true } : undefined,
        );
        await expect(service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 4800,
        }, adminToken)).rejects.toMatchObject({ code: 'address-in-pplns-group' });
    });

    // ── Address lookup cache ───────────────────────────────────────

    it('getGroupIdForAdminAddress resolves the right group while live and clears on dissolve', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'grp', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        expect(service.getGroupIdForAdminAddress('bc1qadmin')).toBe(group.id);

        await service.dissolveGroup(group.id, adminToken);
        expect(service.getGroupIdForAdminAddress('bc1qadmin')).toBeUndefined();
    });

    // ── Pending-party fee-routing defensive guard ────────────────────
    //
    // When an admin's address belongs to a Blockparty that isn't yet
    // READY (i.e. some members still need to confirm their splits), any
    // shares submitted on that address must NOT pay the admin a Solo
    // coinbase — they must redirect 100 % to the pool fee output. The
    // Stratum layer calls getPendingPartyFeeRoute() in its Solo
    // fallback to enforce this.

    it('getPendingPartyFeeRoute: DRAFT admin → fee-only route', async () => {
        const { service } = await buildService();
        // createGroup → DRAFT (admin is sole member)
        await service.createGroup({
            name: 'pending-draft', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        const route = service.getPendingPartyFeeRoute('bc1qadmin');
        expect(route).toEqual([{ address: FEE_ADDR, percent: 100 }]);
    });

    it('getPendingPartyFeeRoute: CONFIRMING admin (member pending) → fee-only route', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'pending-confirming', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        // Add Bob but don't confirm yet → addMember auto-flips DRAFT → CONFIRMING.
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        const route = service.getPendingPartyFeeRoute('bc1qadmin');
        expect(route).toEqual([{ address: FEE_ADDR, percent: 100 }]);
    });

    it('getPendingPartyFeeRoute: READY admin → null (normal Blockparty routing takes over)', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'ready', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');
        // All members confirmed → recomputeStatus flips to READY.
        const route = service.getPendingPartyFeeRoute('bc1qadmin');
        expect(route).toBeNull();
    });

    it('getPendingPartyFeeRoute: ACTIVE admin → null (party is mining)', async () => {
        const { service } = await buildService();
        const { group, adminToken } = await service.createGroup({
            name: 'active', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        await service.addMember(group.id, {
            address: 'bc1qbob', email: 'bob@b.c', percentBp: 5000,
        }, adminToken);
        await service.markMemberConfirmed(group.id, 'bc1qbob');
        await service.onShareAccepted('bc1qadmin');
        // READY → ACTIVE on first share.
        const route = service.getPendingPartyFeeRoute('bc1qadmin');
        expect(route).toBeNull();
    });

    it('getPendingPartyFeeRoute: non-admin address → null', async () => {
        const { service } = await buildService();
        await service.createGroup({
            name: 'unrelated', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        expect(service.getPendingPartyFeeRoute('bc1qstranger')).toBeNull();
    });

    it('getPendingPartyFeeRoute: returns null when fee address is unconfigured', async () => {
        const { service } = await buildService({ PPLNS_FEE_ADDRESS: '' });
        await service.createGroup({
            name: 'no-fee', adminAddress: 'bc1qadmin', adminEmail: 'a@b.c', adminPercentBp: 5000,
        });
        // Without a fee address there's nowhere to route — the regular
        // Solo fallback handles the share. Pool operator misconfig
        // shouldn't crash the Stratum layer.
        expect(service.getPendingPartyFeeRoute('bc1qadmin')).toBeNull();
    });
});
