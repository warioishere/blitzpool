import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from '../ORM/pplns-group/pplns-group-member.entity';

/**
 * Manages group lifecycle (create/transfer/dissolve), membership (add/kick/self-leave),
 * admin-token auth, and an in-memory address→groupId cache used by the stratum layer.
 *
 * Groups are "active" once they have ≥ MIN_MEMBERS_ACTIVE members; the stratum layer
 * refuses connections for addresses that belong to an inactive group.
 */

const MIN_MEMBERS_ACTIVE = 2;

export class GroupServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface GroupCreateResult {
    group: PplnsGroupEntity;
    /** Plain-text admin token — shown to the creator exactly once. */
    adminToken: string;
}

export interface GroupCacheEntry {
    groupId: string;
    active: boolean;
}

@Injectable()
export class GroupService implements OnModuleInit {

    /** address → { groupId, active }. Refreshed on every membership change. */
    private addressCache = new Map<string, GroupCacheEntry>();

    constructor(
        @InjectRepository(PplnsGroupEntity)
        private readonly groupRepo: Repository<PplnsGroupEntity>,
        @InjectRepository(PplnsGroupMemberEntity)
        private readonly memberRepo: Repository<PplnsGroupMemberEntity>,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.rebuildCache();
    }

    /** Full rebuild — called on startup and after any membership change. */
    private async rebuildCache(): Promise<void> {
        const members = await this.memberRepo.find();
        const groupIds = Array.from(new Set(members.map(m => m.groupId)));
        const groups = groupIds.length > 0
            ? await this.groupRepo.find({ where: groupIds.map(id => ({ id, dissolvedAt: IsNull() })) })
            : [];
        const activeById = new Map(groups.map(g => [g.id, g.active]));

        const next = new Map<string, GroupCacheEntry>();
        for (const m of members) {
            const active = activeById.get(m.groupId);
            if (active === undefined) continue; // group dissolved — skip
            next.set(m.address, { groupId: m.groupId, active });
        }
        this.addressCache = next;
    }

    // ── Token helpers ─────────────────────────────────────────────

    private generateToken(): string {
        return 'GRP-' + crypto.randomBytes(24).toString('base64url');
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private verifyToken(providedToken: string, storedHash: string): boolean {
        const providedHash = this.hashToken(providedToken);
        if (providedHash.length !== storedHash.length) return false;
        return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
    }

    async requireAdminToken(groupId: string, token: string | undefined): Promise<PplnsGroupEntity> {
        if (!token) {
            throw new GroupServiceError('missing-token', 'Admin token required');
        }
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) {
            throw new GroupServiceError('not-found', 'Group not found');
        }
        if (!this.verifyToken(token, group.adminTokenHash)) {
            throw new GroupServiceError('invalid-token', 'Invalid admin token');
        }
        return group;
    }

    // ── Lookup ────────────────────────────────────────────────────

    getGroupForAddress(address: string): GroupCacheEntry | undefined {
        return this.addressCache.get(address);
    }

    async getGroup(groupId: string): Promise<PplnsGroupEntity | null> {
        return this.groupRepo.findOneBy({ id: groupId });
    }

    async listGroups(): Promise<PplnsGroupEntity[]> {
        return this.groupRepo.find({ where: { dissolvedAt: IsNull() } });
    }

    async listMembers(groupId: string): Promise<PplnsGroupMemberEntity[]> {
        return this.memberRepo.find({ where: { groupId }, order: { joinedAt: 'ASC' } });
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    async createGroup(name: string, creatorAddress: string): Promise<GroupCreateResult> {
        const trimmedName = name?.trim();
        if (!trimmedName || trimmedName.length < 3 || trimmedName.length > 64) {
            throw new GroupServiceError('invalid-name', 'Group name must be 3–64 characters');
        }
        if (!creatorAddress) {
            throw new GroupServiceError('invalid-address', 'Creator address required');
        }

        const existingByName = await this.groupRepo.findOneBy({ name: trimmedName });
        if (existingByName && !existingByName.dissolvedAt) {
            throw new GroupServiceError('name-taken', 'Group name already in use');
        }

        const existingMember = await this.memberRepo.findOneBy({ address: creatorAddress });
        if (existingMember) {
            throw new GroupServiceError('address-in-group', 'Address is already a member of another group');
        }

        const adminToken = this.generateToken();
        const group = await this.groupRepo.save(this.groupRepo.create({
            id: crypto.randomUUID(),
            name: trimmedName,
            creatorAddress,
            adminTokenHash: this.hashToken(adminToken),
            active: false,
        }));

        await this.memberRepo.save(this.memberRepo.create({
            groupId: group.id,
            address: creatorAddress,
            role: 'creator',
        }));

        await this.rebuildCache();

        return { group, adminToken };
    }

    async addMember(groupId: string, address: string, token: string | undefined): Promise<PplnsGroupMemberEntity> {
        await this.requireAdminToken(groupId, token);
        return this.addMemberWithoutAdmin(groupId, address);
    }

    /**
     * Add a member bypassing the admin-token check. Intended for callers
     * that have already verified authorization through a different
     * mechanism — currently only the invitation-accept flow, where the
     * invitee proves they own the address by clicking the email link.
     */
    async addMemberWithoutAdmin(groupId: string, address: string): Promise<PplnsGroupMemberEntity> {
        if (!address) {
            throw new GroupServiceError('invalid-address', 'Address required');
        }

        const existing = await this.memberRepo.findOneBy({ address });
        if (existing) {
            if (existing.groupId === groupId) {
                throw new GroupServiceError('already-member', 'Address is already in this group');
            }
            throw new GroupServiceError('address-in-group', 'Address is already a member of another group');
        }

        const member = await this.memberRepo.save(this.memberRepo.create({
            groupId,
            address,
            role: 'member',
        }));

        await this.recomputeActive(groupId);
        await this.rebuildCache();
        return member;
    }

    /**
     * Adds multiple members in a single token check + single cache rebuild.
     * Benign per-address failures (already-member, address-in-group, empty
     * address) are collected into `skipped` instead of aborting the batch.
     * Token failures still throw and abort — they're not a per-address
     * issue but a missing/invalid auth credential.
     */
    async addMembersBatch(
        groupId: string,
        addresses: string[],
        token: string | undefined,
    ): Promise<{
        added: { address: string; role: 'member'; joinedAt: Date }[];
        skipped: { address: string; reason: 'already-member' | 'address-in-group' | 'invalid-address' | 'duplicate-in-batch' }[];
    }> {
        await this.requireAdminToken(groupId, token);

        const added: { address: string; role: 'member'; joinedAt: Date }[] = [];
        const skipped: { address: string; reason: 'already-member' | 'address-in-group' | 'invalid-address' | 'duplicate-in-batch' }[] = [];
        const seen = new Set<string>();
        let anyAdded = false;

        for (const raw of addresses) {
            const address = (raw ?? '').trim();
            if (!address) {
                skipped.push({ address: raw, reason: 'invalid-address' });
                continue;
            }
            if (seen.has(address)) {
                skipped.push({ address, reason: 'duplicate-in-batch' });
                continue;
            }
            seen.add(address);

            const existing = await this.memberRepo.findOneBy({ address });
            if (existing) {
                skipped.push({
                    address,
                    reason: existing.groupId === groupId ? 'already-member' : 'address-in-group',
                });
                continue;
            }

            const saved = await this.memberRepo.save(this.memberRepo.create({
                groupId,
                address,
                role: 'member',
            }));
            added.push({ address: saved.address, role: 'member', joinedAt: saved.joinedAt });
            anyAdded = true;
        }

        if (anyAdded) {
            await this.recomputeActive(groupId);
            await this.rebuildCache();
        }
        return { added, skipped };
    }

    async removeMember(groupId: string, address: string, token: string | undefined): Promise<void> {
        await this.requireAdminToken(groupId, token);
        await this.internalRemove(groupId, address, /*fromCreator*/ true);
    }

    async selfLeave(groupId: string, address: string): Promise<void> {
        const member = await this.memberRepo.findOneBy({ groupId, address });
        if (!member) {
            throw new GroupServiceError('not-member', 'Address is not a member of this group');
        }
        if (member.role === 'creator') {
            throw new GroupServiceError('creator-cannot-self-leave', 'Creator must transfer role or dissolve the group before leaving');
        }
        await this.internalRemove(groupId, address, /*fromCreator*/ false);
    }

    private async internalRemove(groupId: string, address: string, fromCreator: boolean): Promise<void> {
        const member = await this.memberRepo.findOneBy({ groupId, address });
        if (!member) {
            throw new GroupServiceError('not-member', 'Address is not a member of this group');
        }

        if (member.role === 'creator') {
            // Creator removal: auto-transfer to oldest remaining member, or dissolve if none.
            const remaining = await this.memberRepo.find({
                where: { groupId },
                order: { joinedAt: 'ASC' },
            });
            const others = remaining.filter(m => m.address !== address);
            if (others.length === 0) {
                await this.dissolveInternal(groupId);
                return;
            }
            const newCreator = others[0];
            newCreator.role = 'creator';
            await this.memberRepo.save(newCreator);
            // Rotate admin token so old one can't be used anymore.
            const newToken = this.generateToken();
            const group = await this.groupRepo.findOneBy({ id: groupId });
            if (group) {
                group.adminTokenHash = this.hashToken(newToken);
                group.creatorAddress = newCreator.address;
                await this.groupRepo.save(group);
            }
            // NOTE: The new admin token can't be returned from this path since it's
            // triggered by a creator-leave. The new creator must call /recover if
            // they don't have the token. (Recovery not implemented in MVP.)
        }

        await this.memberRepo.delete({ groupId, address });
        await this.recomputeActive(groupId);
        await this.rebuildCache();
    }

    /**
     * Explicit creator handoff with a freshly-issued admin token.
     * The current creator calls this; the new admin token is returned (once).
     */
    async transferCreator(
        groupId: string,
        toAddress: string,
        token: string | undefined,
    ): Promise<{ group: PplnsGroupEntity; adminToken: string }> {
        const group = await this.requireAdminToken(groupId, token);
        const newCreator = await this.memberRepo.findOneBy({ groupId, address: toAddress });
        if (!newCreator) {
            throw new GroupServiceError('not-member', 'Target address is not a member of this group');
        }
        if (newCreator.role === 'creator') {
            throw new GroupServiceError('already-creator', 'Target is already the creator');
        }

        const oldCreator = await this.memberRepo.findOne({ where: { groupId, role: 'creator' } });
        if (oldCreator) {
            oldCreator.role = 'member';
            await this.memberRepo.save(oldCreator);
        }
        newCreator.role = 'creator';
        await this.memberRepo.save(newCreator);

        const newToken = this.generateToken();
        group.adminTokenHash = this.hashToken(newToken);
        group.creatorAddress = toAddress;
        const saved = await this.groupRepo.save(group);

        await this.rebuildCache();
        return { group: saved, adminToken: newToken };
    }

    async dissolveGroup(groupId: string, token: string | undefined): Promise<void> {
        await this.requireAdminToken(groupId, token);
        await this.dissolveInternal(groupId);
    }

    private async dissolveInternal(groupId: string): Promise<void> {
        await this.memberRepo.delete({ groupId });
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (group) {
            group.active = false;
            group.dissolvedAt = new Date();
            await this.groupRepo.save(group);
        }
        await this.rebuildCache();
    }

    private async recomputeActive(groupId: string): Promise<void> {
        const count = await this.memberRepo.count({ where: { groupId } });
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) return;
        const shouldBeActive = count >= MIN_MEMBERS_ACTIVE;
        if (group.active !== shouldBeActive) {
            group.active = shouldBeActive;
            await this.groupRepo.save(group);
        }
    }
}
