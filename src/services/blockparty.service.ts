import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { BlockpartyGroupEntity, BlockpartyStatus } from '../ORM/blockparty/blockparty-group.entity';
import { BlockpartyMemberEntity } from '../ORM/blockparty/blockparty-member.entity';
import {
    BlockpartyBlockHistoryEntity,
    BlockpartySplitSnapshot,
} from '../ORM/blockparty/blockparty-block-history.entity';
import { normalizeBtcAddress } from '../utils/btc-address.utils';
import { resolveMinPayoutSats } from './coinbase-distribution';
import {
    BlockpartyDistributionResult,
    buildBlockpartyDistribution,
} from './blockparty-distribution';
import { GroupService } from './group.service';
import { AddressEmailService } from './address-email.service';

const MIN_PERCENT_BP = 100;    // 1 %
const MAX_PERCENT_BP = 10000;  // 100 % (solo admin = sole member)
const TOTAL_PERCENT_BP = 10000;

const NAME_MIN_LEN = 3;
const NAME_MAX_LEN = 64;
const EMAIL_MAX_LEN = 320;

const MS_PER_HOUR = 60 * 60 * 1000;
// 7-day post-share lock before the admin can dissolve. A failed rental
// (provider drops, no-fill) lets the admin take a refund and re-buy
// hashrate within typical 2-3 day turnarounds — a 24h cooldown wasn't
// enough headroom for that recovery path. 7 days covers it generously.
const DISSOLVE_COOLDOWN_MS = 7 * 24 * MS_PER_HOUR;

const EDITABLE_STATES: ReadonlyArray<BlockpartyStatus> = ['draft', 'confirming', 'ready'];

export class BlockpartyServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface BlockpartyCreateResult {
    group: BlockpartyGroupEntity;
    /** Plain-text admin token — shown to the creator exactly once. */
    adminToken: string;
}

export interface BlockpartyMemberInput {
    address: string;
    percentBp: number;
    /**
     * Optional. When omitted, the verified email binding for the address
     * is used automatically (mirror of the Group-Solo invite flow).
     * Pass-through retained so callers that know the email up-front can
     * still set it explicitly.
     */
    email?: string;
}

@Injectable()
export class BlockpartyService implements OnModuleInit {

    private readonly feeAddress: string;
    private readonly feePercent: number;
    private readonly minPayoutSats: number;

    /** address (lowercased) → groupId, refreshed on every membership change. */
    private addressCache = new Map<string, string>();
    /** admin address (lowercased) → { groupId, status } for fast share-path lookup. */
    private adminAddressCache = new Map<string, { groupId: string; status: BlockpartyStatus }>();

    constructor(
        @InjectRepository(BlockpartyGroupEntity)
        private readonly groupRepo: Repository<BlockpartyGroupEntity>,
        @InjectRepository(BlockpartyMemberEntity)
        private readonly memberRepo: Repository<BlockpartyMemberEntity>,
        @InjectRepository(BlockpartyBlockHistoryEntity)
        private readonly historyRepo: Repository<BlockpartyBlockHistoryEntity>,
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => GroupService))
        private readonly groupService: GroupService,
        private readonly addressEmailService: AddressEmailService,
    ) {
        // Group-Solo + Blockparty share a fee config that is independent
        // from the PPLNS lane (PPLNS keeps its own PPLNS_FEE_*). New
        // operators set GROUP_FEE_*; existing deployments that only set
        // PPLNS_FEE_* keep working because of the fallback.
        this.feeAddress = this.configService.get('GROUP_FEE_ADDRESS')
            ?? this.configService.get('PPLNS_FEE_ADDRESS') ?? '';
        this.feePercent = parseFloat(
            this.configService.get('GROUP_FEE_PERCENT')
            ?? this.configService.get('PPLNS_FEE_PERCENT') ?? '2',
        );
        this.minPayoutSats = resolveMinPayoutSats(this.configService.get('PPLNS_MIN_PAYOUT_SATS'));
    }

    async onModuleInit(): Promise<void> {
        await this.rebuildCache();
    }

    private async rebuildCache(): Promise<void> {
        const groups = await this.groupRepo.find();
        const liveGroupIds = new Set(groups.filter(g => g.status !== 'dissolved').map(g => g.id));

        const members = await this.memberRepo.find();
        const addrCache = new Map<string, string>();
        for (const m of members) {
            if (!liveGroupIds.has(m.groupId)) continue;
            addrCache.set(m.address, m.groupId);
        }

        const adminCache = new Map<string, { groupId: string; status: BlockpartyStatus }>();
        for (const g of groups) {
            if (g.status === 'dissolved') continue;
            adminCache.set(g.adminAddress, { groupId: g.id, status: g.status });
        }
        this.addressCache = addrCache;
        this.adminAddressCache = adminCache;
    }

    // ── Token helpers ─────────────────────────────────────────────

    private generateToken(): string {
        return 'BP-' + crypto.randomBytes(24).toString('base64url');
    }

    private generateMemberToken(): string {
        return 'BPM-' + crypto.randomBytes(24).toString('base64url');
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private verifyToken(providedToken: string, storedHash: string): boolean {
        const providedHash = this.hashToken(providedToken);
        if (providedHash.length !== storedHash.length) return false;
        return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
    }

    async requireAdminToken(groupId: string, token: string | undefined): Promise<BlockpartyGroupEntity> {
        if (!token) {
            throw new BlockpartyServiceError('missing-token', 'Admin token required');
        }
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group) {
            throw new BlockpartyServiceError('not-found', 'Blockparty not found');
        }
        if (!this.verifyToken(token, group.adminTokenHash)) {
            throw new BlockpartyServiceError('invalid-token', 'Invalid admin token');
        }
        return group;
    }

    // ── Read paths ────────────────────────────────────────────────

    getGroupIdForAddress(address: string): string | undefined {
        return this.addressCache.get(normalizeBtcAddress(address));
    }

    getGroupIdForAdminAddress(address: string): string | undefined {
        return this.adminAddressCache.get(normalizeBtcAddress(address))?.groupId;
    }

    /**
     * Wire-level routing helper for the Stratum layer. Returns the active
     * groupId for the address ONLY if the party status permits coinbase
     * emission (i.e. confirming, ready, or active). Skips draft (admin
     * hasn't finalised splits yet) and dissolved (terminal).
     *
     * Reading from the in-memory cache keeps this O(1) per share — share
     * frequency at 1-3 rental proxies/party is moderate but still the
     * hottest path the Blockparty engine touches.
     */
    getRoutableGroupIdForAdmin(address: string): string | undefined {
        const entry = this.adminAddressCache.get(normalizeBtcAddress(address));
        if (!entry) return undefined;
        // Only READY (all confirmed, awaiting first share) and ACTIVE
        // (work flowing) route to a Blockparty coinbase. CONFIRMING
        // (some members still unconfirmed) and DRAFT fall through to
        // solo — sats land in the pool-fee output rather than getting
        // distributed against splits the party hasn't fully signed off
        // on yet. Closes the "hashpower drift / early rental" hole
        // where an unconfirmed member would otherwise still receive
        // on-chain payouts.
        if (entry.status !== 'ready' && entry.status !== 'active') return undefined;
        return entry.groupId;
    }

    async getGroup(groupId: string): Promise<BlockpartyGroupEntity | null> {
        return this.groupRepo.findOneBy({ id: groupId });
    }

    async listMembers(groupId: string): Promise<BlockpartyMemberEntity[]> {
        return this.memberRepo.find({ where: { groupId }, order: { createdAt: 'ASC' } });
    }

    async listGroups(): Promise<BlockpartyGroupEntity[]> {
        return this.groupRepo.find({ order: { createdAt: 'DESC' } });
    }

    async getHistory(groupId: string): Promise<BlockpartyBlockHistoryEntity[]> {
        return this.historyRepo.find({ where: { groupId }, order: { foundAt: 'DESC' } });
    }

    /** Read-only access to the configured pool fee percent (e.g. 2). */
    getPoolFeePercent(): number {
        return this.feePercent;
    }

    /** Read-only access to the configured Blockparty pool fee address. */
    getFeeAddress(): string {
        return this.feeAddress;
    }

    /**
     * Defensive coinbase override for the Stratum fallback path. When an
     * address is the admin of a CONFIRMING or DRAFT Blockparty (status
     * not yet routable above), block-found shares would otherwise fall
     * through to a Solo coinbase that pays the admin 100 % — closing
     * the "premature rental" hole where the admin could collect the
     * whole reward before members had signed off on their splits. We
     * route the block to the pool-fee address instead.
     *
     * Returns null when the address isn't an admin, the party is
     * ready/active/dissolved, or no fee address is configured (in which
     * case the regular Solo fallback handles it).
     */
    getPendingPartyFeeRoute(address: string | undefined): { address: string; percent: number }[] | null {
        if (!address || !this.feeAddress) return null;
        const normalized = normalizeBtcAddress(address);
        if (!normalized) return null;
        const entry = this.adminAddressCache.get(normalized);
        if (!entry) return null;
        if (entry.status !== 'draft' && entry.status !== 'confirming') return null;
        return [{ address: this.feeAddress, percent: 100 }];
    }

    // ── Lifecycle ────────────────────────────────────────────────

    /**
     * Create a draft Blockparty. The creator (treasury-address owner) is
     * inserted as the first member with `role='admin'`, percentBp from
     * `adminPercentBp`. Additional members are added with `addMember` —
     * percentBp must sum to (10000 − feePercent×100) before transition out
     * of DRAFT.
     */
    async createGroup(params: {
        name: string;
        adminAddress: string;
        adminEmail: string;
        adminPercentBp: number;
    }): Promise<BlockpartyCreateResult> {
        const trimmedName = params.name?.trim();
        if (!trimmedName || trimmedName.length < NAME_MIN_LEN || trimmedName.length > NAME_MAX_LEN) {
            throw new BlockpartyServiceError('invalid-name', `Name must be ${NAME_MIN_LEN}-${NAME_MAX_LEN} characters`);
        }
        if (/[\x00-\x1f\x7f]/.test(trimmedName)) {
            throw new BlockpartyServiceError('invalid-name', 'Name must not contain control characters');
        }

        const normalizedAdmin = normalizeBtcAddress(params.adminAddress);
        if (!normalizedAdmin) {
            throw new BlockpartyServiceError('invalid-address', 'Admin address required');
        }

        this.assertEmailShape(params.adminEmail);
        this.assertPercentBpInRange(params.adminPercentBp);

        const nameClash = await this.groupRepo.findOneBy({ name: trimmedName });
        if (nameClash) {
            throw new BlockpartyServiceError('name-taken', 'Blockparty name already in use');
        }
        const addrClash = await this.groupRepo.findOneBy({ adminAddress: normalizedAdmin });
        if (addrClash) {
            throw new BlockpartyServiceError('admin-address-taken', 'Admin address already runs a Blockparty');
        }
        const memberClash = await this.memberRepo.findOneBy({ address: normalizedAdmin });
        if (memberClash) {
            throw new BlockpartyServiceError('address-in-blockparty', 'Address is already a member of a Blockparty');
        }
        this.assertNotInPplnsGroup(normalizedAdmin);

        const adminToken = this.generateToken();
        const group = await this.groupRepo.save(this.groupRepo.create({
            id: crypto.randomUUID(),
            name: trimmedName,
            adminAddress: normalizedAdmin,
            adminTokenHash: this.hashToken(adminToken),
            status: 'draft',
            lastShareAt: null,
            dissolvedAt: null,
        }));

        await this.memberRepo.save(this.memberRepo.create({
            groupId: group.id,
            address: normalizedAdmin,
            email: params.adminEmail.trim().toLowerCase(),
            percentBp: params.adminPercentBp,
            role: 'admin',
            confirmedAt: Date.now(),
        }));

        await this.rebuildCache();
        return { group, adminToken };
    }

    async addMember(
        groupId: string,
        member: BlockpartyMemberInput,
        token: string | undefined,
    ): Promise<BlockpartyMemberEntity> {
        const group = await this.requireAdminToken(groupId, token);
        this.assertEditable(group);

        const normalized = normalizeBtcAddress(member.address);
        if (!normalized) {
            throw new BlockpartyServiceError('invalid-address', 'Address required');
        }
        if (normalized === group.adminAddress) {
            throw new BlockpartyServiceError('admin-cannot-rejoin', 'Admin is already a member');
        }
        this.assertPercentBpInRange(member.percentBp);

        const memberClash = await this.memberRepo.findOneBy({ address: normalized });
        if (memberClash) {
            throw new BlockpartyServiceError('address-in-blockparty', 'Address is already a member of a Blockparty');
        }
        this.assertNotInPplnsGroup(normalized);
        // Email is ALWAYS pulled from the verified binding — admin input
        // is ignored even if supplied. This matches Group-Solo's invite
        // flow and avoids the failure mode where a controller forwards
        // an empty string and the service treats it as "supplied but
        // bad". The binding email is the canonical source of truth.
        const binding = await this.addressEmailService.getVerified(normalized);
        if (!binding) {
            throw new BlockpartyServiceError(
                'email-not-verified',
                'Address has no verified email. The invitee must bind + verify an email in their settings first.',
            );
        }
        const resolvedEmail = binding.email.toLowerCase();

        let saved: BlockpartyMemberEntity;
        try {
            saved = await this.memberRepo.save(this.memberRepo.create({
                groupId,
                address: normalized,
                email: resolvedEmail,
                percentBp: member.percentBp,
                role: 'member',
                confirmedAt: null,
            }));
        } catch (err: any) {
            // Concurrent admin clicks can race past the findOneBy check
            // above. The unique index on member.address catches it as
            // 23505 — surface as a typed error so the UI shows the
            // address-collision toast instead of a generic 500.
            if (err?.code === '23505' || err?.driverError?.code === '23505') {
                throw new BlockpartyServiceError('address-in-blockparty', 'Address is already a member of a Blockparty');
            }
            throw err;
        }

        // First member added to a DRAFT party promotes it to CONFIRMING —
        // the manual "send invitations" button is gone, the act of adding
        // a member IS the trigger. assertSplitsSumValid is intentionally
        // NOT called here: the admin can stage the party incrementally
        // and the splits-save action validates separately. CONFIRMING ↔
        // READY then auto-transitions via recomputeStatus.
        if (group.status === 'draft') {
            group.status = 'confirming';
            group.updatedAt = Date.now();
            await this.groupRepo.save(group);
        }
        await this.recomputeStatus(groupId);
        await this.rebuildCache();
        return saved;
    }

    async removeMember(groupId: string, address: string, token: string | undefined): Promise<void> {
        const group = await this.requireAdminToken(groupId, token);
        this.assertEditable(group);

        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new BlockpartyServiceError('invalid-address', 'Address required');
        }
        const member = await this.memberRepo.findOneBy({ groupId, address: normalized });
        if (!member) {
            throw new BlockpartyServiceError('not-member', 'Address is not a member of this Blockparty');
        }
        if (member.role === 'admin') {
            throw new BlockpartyServiceError('admin-cannot-be-removed', 'Admin must dissolve the party to leave');
        }

        await this.memberRepo.delete({ id: member.id });
        await this.recomputeStatus(groupId);
        await this.rebuildCache();
    }

    /**
     * Set new percentBp values for one or more members. Non-admin members'
     * confirmations are reset (transparency: any %-change shifts the
     * deal they agreed to). The ADMIN row keeps its confirmedAt — the
     * admin authored the edit, so their participation in the new shape
     * is implicit. The percentBp itself is still written for the admin
     * row if supplied. Sum check still requires 10000 = 100 % of miner cut.
     */
    async updateSplits(
        groupId: string,
        updates: Array<{ address: string; percentBp: number }>,
        token: string | undefined,
    ): Promise<void> {
        const group = await this.requireAdminToken(groupId, token);
        this.assertEditable(group);

        const normalizedUpdates = updates.map(u => {
            const normalized = normalizeBtcAddress(u.address);
            if (!normalized) {
                throw new BlockpartyServiceError('invalid-address', `Invalid address ${u.address}`);
            }
            this.assertPercentBpInRange(u.percentBp);
            return { address: normalized, percentBp: u.percentBp };
        });

        const adminAddress = group.adminAddress;

        await this.memberRepo.manager.transaction(async em => {
            const repo = em.getRepository(this.memberRepo.target);
            // Iterate the full member set so we can apply both edits
            // and confirmation-reset in a single per-row update —
            // avoids relying on createQueryBuilder for the WHERE-NOT
            // case (cleaner to mock + simpler to reason about).
            const all = await repo.find({ where: { groupId } });
            const editByAddress = new Map(normalizedUpdates.map(u => [u.address, u.percentBp]));
            // Defensive: every supplied address must actually be a member.
            for (const u of normalizedUpdates) {
                if (!all.some((m: any) => m.address === u.address)) {
                    throw new BlockpartyServiceError('not-member', `${u.address} is not a member`);
                }
            }
            const now = Date.now();
            for (const m of all as any[]) {
                const patch: Record<string, any> = { updatedAt: now };
                const newPercent = editByAddress.get(m.address);
                if (newPercent != null) patch['percentBp'] = newPercent;
                // Admin row: refresh confirmedAt explicitly — the edit IS
                // the admin's consent to this new splits version. Forcing
                // the timestamp also self-heals any pre-fix data where
                // confirmedAt might have been null.
                // Non-admin rows: reset so members re-acknowledge.
                if (m.address === adminAddress) {
                    patch['confirmedAt'] = now;
                } else {
                    patch['confirmedAt'] = null;
                }
                await repo.update({ id: m.id }, patch);
            }
        });

        await this.recomputeStatus(groupId);
    }

    /**
     * Mark a single member as confirmed. Used by the invitation-accept
     * flow (step 4) — the caller has already verified the invitation
     * token, so no admin-token check here.
     *
     * Mints a persistent member-token on first accept (when no
     * memberTokenHash exists yet) so subsequent re-confirms (after admin
     * %-edits) and gated read access don't need a fresh invitation cycle.
     * The plain token is returned exactly once — callers must surface it
     * to the recipient.
     */
    /**
     * Wipe the member's onboarding state — memberTokenHash + confirmedAt —
     * so the next markMemberConfirmed re-mints a fresh BPM-... token. The
     * lost-token recovery path: admin clicks Resend, this clears the
     * old hash, recipient re-accepts via the new invitation link, and
     * the accept flow surfaces a new plain token exactly once. Idempotent
     * on members that haven't onboarded yet (no-op).
     */
    async resetMemberOnboarding(groupId: string, address: string): Promise<void> {
        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new BlockpartyServiceError('invalid-address', 'Address required');
        }
        const member = await this.memberRepo.findOneBy({ groupId, address: normalized });
        if (!member) return; // resend on a non-member is the caller's bug, not ours
        if (member.memberTokenHash == null && member.confirmedAt == null) return;
        member.memberTokenHash = null;
        member.confirmedAt = null;
        member.updatedAt = Date.now();
        await this.memberRepo.save(member);
        await this.recomputeStatus(groupId);
    }

    async markMemberConfirmed(groupId: string, address: string): Promise<{ memberToken: string | null }> {
        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new BlockpartyServiceError('invalid-address', 'Address required');
        }
        const member = await this.memberRepo.findOneBy({ groupId, address: normalized });
        if (!member) {
            throw new BlockpartyServiceError('not-member', 'Address is not a member of this Blockparty');
        }

        let mintedPlain: string | null = null;
        if (member.memberTokenHash == null) {
            mintedPlain = this.generateMemberToken();
            member.memberTokenHash = this.hashToken(mintedPlain);
        }

        if (member.confirmedAt == null) {
            member.confirmedAt = Date.now();
        }
        member.updatedAt = Date.now();
        await this.memberRepo.save(member);
        await this.recomputeStatus(groupId);
        return { memberToken: mintedPlain };
    }

    /**
     * Re-confirm an existing member after an admin %-edit reset the
     * confirmation. Authenticated with the persistent member token issued
     * on first accept — no invitation cycle needed for follow-up confirms.
     * Idempotent: a second call while already confirmed is a no-op.
     */
    async confirmAsMember(groupId: string, address: string, memberToken: string | undefined): Promise<void> {
        await this.requireMemberToken(groupId, address, memberToken);
        const normalized = normalizeBtcAddress(address);
        const member = await this.memberRepo.findOneBy({ groupId, address: normalized });
        if (!member) {
            throw new BlockpartyServiceError('not-member', 'Address is not a member of this Blockparty');
        }
        if (member.confirmedAt != null) return;
        member.confirmedAt = Date.now();
        member.updatedAt = Date.now();
        await this.memberRepo.save(member);
        await this.recomputeStatus(groupId);
    }

    /**
     * Auth helper for member-scoped operations. Returns the member row
     * on success; throws on missing/invalid token. Constant-time hash
     * compare — same pattern as the admin token.
     */
    async requireMemberToken(
        groupId: string,
        address: string,
        token: string | undefined,
    ): Promise<BlockpartyMemberEntity> {
        if (!token) {
            throw new BlockpartyServiceError('missing-member-token', 'Member token required');
        }
        const normalized = normalizeBtcAddress(address);
        const member = await this.memberRepo.findOneBy({ groupId, address: normalized });
        if (!member) {
            throw new BlockpartyServiceError('not-member', 'Address is not a member of this Blockparty');
        }
        if (member.memberTokenHash == null) {
            throw new BlockpartyServiceError('member-not-confirmed', 'Member has not accepted the invitation yet');
        }
        if (!this.verifyToken(token, member.memberTokenHash)) {
            throw new BlockpartyServiceError('invalid-member-token', 'Invalid member token');
        }
        return member;
    }

    async updateRentalProviderHint(
        groupId: string,
        hint: string | null,
        token: string | undefined,
    ): Promise<BlockpartyGroupEntity> {
        const group = await this.requireAdminToken(groupId, token);
        const cleaned = hint == null ? null : hint.trim().slice(0, 64);
        group.rentalProviderHint = cleaned && cleaned.length > 0 ? cleaned : null;
        group.updatedAt = Date.now();
        return this.groupRepo.save(group);
    }


    /**
     * Move the group from DRAFT to CONFIRMING. The invitation-send flow
     * (step 4) calls this after persisting the per-member invitation tokens.
     * Validates the splits sum is consistent with the configured pool fee
     * before allowing the transition.
     */
    async transitionToConfirming(groupId: string, token: string | undefined): Promise<void> {
        const group = await this.requireAdminToken(groupId, token);
        // ACTIVE / DISSOLVED states are terminal — refuse. CONFIRMING /
        // READY are accepted as no-op (already past the transition; the
        // new flow auto-flips on first addMember). DRAFT does the
        // original explicit transition.
        if (group.status === 'active' || group.status === 'dissolved') {
            throw new BlockpartyServiceError(
                'invalid-state',
                `Cannot transition to CONFIRMING from ${group.status}`,
            );
        }
        await this.assertSplitsSumValid(groupId);
        if (group.status === 'confirming' || group.status === 'ready') {
            return;
        }
        group.status = 'confirming';
        group.updatedAt = Date.now();
        await this.groupRepo.save(group);
        // Subsequent confirmations may push us straight to READY.
        await this.recomputeStatus(groupId);
    }

    async dissolveGroup(groupId: string, token: string | undefined): Promise<void> {
        const group = await this.requireAdminToken(groupId, token);
        if (group.status === 'dissolved') return; // idempotent

        if (group.status === 'active') {
            const last = group.lastShareAt ?? 0;
            const elapsed = Date.now() - last;
            if (elapsed < DISSOLVE_COOLDOWN_MS) {
                const hoursLeft = Math.ceil((DISSOLVE_COOLDOWN_MS - elapsed) / MS_PER_HOUR);
                const daysLeft = Math.ceil(hoursLeft / 24);
                throw new BlockpartyServiceError(
                    'dissolve-cooldown',
                    `Dissolve allowed only after 7 days of hashrate silence — ~${daysLeft} day(s) remaining`,
                );
            }
        }

        group.status = 'dissolved';
        group.dissolvedAt = Date.now();
        group.updatedAt = Date.now();
        await this.groupRepo.save(group);
        await this.rebuildCache();
    }

    // ── Share / Block hooks ──────────────────────────────────────

    /**
     * Called from the share-accept path. Stratum supplies the miner address
     * — Blockparty mode is triggered when that equals the admin treasury
     * address of an active blockparty. Side effects:
     *   - refresh `lastShareAt` (drives the 7-day dissolve cooldown)
     *   - first share transitions READY (or CONFIRMING, if admin chose to
     *     start without all confirmations) → ACTIVE, permanently freezing
     *     the splits.
     */
    async onShareAccepted(adminAddress: string): Promise<void> {
        const normalized = normalizeBtcAddress(adminAddress);
        if (!normalized) return;
        const cached = this.adminAddressCache.get(normalized);
        if (!cached) return;

        const group = await this.groupRepo.findOneBy({ id: cached.groupId });
        if (!group || group.status === 'dissolved') return;

        const now = Date.now();
        // Only READY → ACTIVE. Shares only reach this handler at all
        // when getRoutableGroupIdForAdmin returned a groupId, which now
        // requires status ∈ {ready, active}. CONFIRMING/DRAFT shouldn't
        // route here in the first place; the explicit check below is
        // defensive against race conditions where status changes
        // between route-decision and share-accept.
        const shouldActivate = group.status === 'ready';

        group.lastShareAt = now;
        if (shouldActivate) {
            group.status = 'active';
        }
        group.updatedAt = now;
        await this.groupRepo.save(group);

        // Cache the new status so subsequent share-path lookups see it
        // without re-hitting the DB.
        this.adminAddressCache.set(normalized, { groupId: group.id, status: group.status });
    }

    /**
     * Compute the per-member payout split for a found block. Pure read —
     * use the result to build coinbase outputs at template time. Cached
     * in callers if needed; no cache here because the inputs (member list,
     * percentBp, feePercent) are stable while the group is ACTIVE.
     */
    async getPayoutDistribution(
        groupId: string,
        blockRewardSats: number,
    ): Promise<BlockpartyDistributionResult> {
        const members = await this.listMembers(groupId);
        return buildBlockpartyDistribution({
            members: members.map(m => ({ address: m.address, percentBp: m.percentBp })),
            blockRewardSats,
            poolFeeAddress: this.feeAddress,
            poolFeePercent: this.feePercent,
            minPayoutSats: this.minPayoutSats,
        });
    }

    /**
     * Record a found block. Idempotent — relies on the unique index on
     * (groupId, blockHash). Returns null when the row already exists.
     *
     * Wire-friendly signature: the Stratum layer passes the on-chain
     * block hash (`bitcoinjs.Block.getId()`); the per-member split is
     * recomputed internally from current `percentBp` values. No
     * pre-snapshot needed because Blockparty distribution is purely
     * function-of-membership (no shares).
     */
    async onBlockFound(params: {
        groupId: string;
        blockHeight: number;
        blockHash: string;
        coinbaseValueSats: number;
        /** Defaults to Date.now() when omitted. */
        foundAt?: number;
    }): Promise<BlockpartyBlockHistoryEntity | null> {
        const distribution = await this.getPayoutDistribution(params.groupId, params.coinbaseValueSats);
        const splits: BlockpartySplitSnapshot[] = distribution.splits.map(s => ({
            address: s.address,
            percentBp: s.percentBp,
            sats: s.sats,
            ...(s.trimmed ? { trimmed: true } : {}),
        }));

        try {
            const row = await this.historyRepo.save(this.historyRepo.create({
                groupId: params.groupId,
                blockHeight: params.blockHeight,
                blockHash: params.blockHash,
                foundAt: params.foundAt ?? Date.now(),
                coinbaseValueSats: params.coinbaseValueSats,
                poolFeeSats: distribution.poolFeeSats,
                splits,
            }));
            return row;
        } catch (err) {
            if ((err as { code?: string }).code === '23505') {
                // Race: another caller wrote the same (groupId, blockHash). Idempotent no-op.
                return null;
            }
            throw err;
        }
    }

    // ── Validation helpers ──────────────────────────────────────

    /**
     * Reject the address if there's no verified email binding for it.
     * Mirrors PPLNS-group invitation policy: invitees must have proved
     * control of an email address before an admin can pull them into a
     * payout group — protects against doxxing-by-invitation (an admin
     * cannot send mail to an arbitrary email pretending to be the
     * invitee).
     */
    private async assertEmailVerified(address: string): Promise<void> {
        const binding = await this.addressEmailService.getVerified(address);
        if (!binding) {
            throw new BlockpartyServiceError(
                'email-not-verified',
                'Address has no verified email. The invitee must bind + verify an email in their settings first.',
            );
        }
    }

    /**
     * Reject the address if it's already a member of any active
     * PPLNS-group (which covers Group-Solo too). The check uses the
     * GroupService in-memory cache populated at startup — same source
     * of truth the stratum routing layer reads. An address can be in
     * at most one membership-driven mode at a time.
     */
    private assertNotInPplnsGroup(address: string): void {
        const entry = this.groupService.getGroupForAddress(address);
        if (entry) {
            throw new BlockpartyServiceError(
                'address-in-pplns-group',
                'Address is already a member of a PPLNS group — leave that group first',
            );
        }
    }

    private assertEditable(group: BlockpartyGroupEntity): void {
        if (!EDITABLE_STATES.includes(group.status)) {
            throw new BlockpartyServiceError(
                'not-editable',
                `Blockparty is ${group.status} — edits are no longer permitted`,
            );
        }
    }

    private assertPercentBpInRange(percentBp: number): void {
        if (!Number.isInteger(percentBp) || percentBp < MIN_PERCENT_BP || percentBp > MAX_PERCENT_BP) {
            throw new BlockpartyServiceError(
                'invalid-percent',
                `percentBp must be an integer in [${MIN_PERCENT_BP}, ${MAX_PERCENT_BP}] (basis points, 100=1%)`,
            );
        }
    }

    private assertEmailShape(email: string): void {
        const trimmed = email?.trim().toLowerCase();
        if (!trimmed || trimmed.length > EMAIL_MAX_LEN) {
            throw new BlockpartyServiceError('invalid-email', 'Email required');
        }
        // Minimal sanity check — full RFC validation lives in EmailService.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            throw new BlockpartyServiceError('invalid-email', 'Email format invalid');
        }
    }

    /**
     * Members' percentBp represents their share of the *miner cut*
     * (= block reward minus pool fee). Sum must equal TOTAL_PERCENT_BP
     * (= 10000 = 100 %). The pool fee is deducted by buildBlockpartyDistribution
     * before splits are applied; members never see it on the percentage
     * scale they're configuring. Solo admin → 10000 (sole member).
     */
    private async assertSplitsSumValid(groupId: string): Promise<void> {
        const members = await this.memberRepo.find({ where: { groupId } });
        if (members.length === 0) {
            throw new BlockpartyServiceError('no-members', 'Blockparty has no members');
        }
        const actual = members.reduce((acc, m) => acc + m.percentBp, 0);
        if (actual !== TOTAL_PERCENT_BP) {
            throw new BlockpartyServiceError(
                'invalid-splits-sum',
                `Sum of member percentBp must equal ${TOTAL_PERCENT_BP} (100 % of miner cut, current: ${actual})`,
            );
        }
    }

    /**
     * CONFIRMING vs READY is computed: when every member has confirmedAt,
     * the group is READY; otherwise CONFIRMING. No automatic transition
     * back to DRAFT — once invitations have gone out, the editing model
     * is "edit-with-confirmation-reset", not "back to scratch".
     */
    private async recomputeStatus(groupId: string): Promise<void> {
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group) return;
        if (group.status !== 'confirming' && group.status !== 'ready') return;

        const members = await this.memberRepo.find({ where: { groupId } });
        const allConfirmed = members.length > 0 && members.every(m => m.confirmedAt != null);
        const target: BlockpartyStatus = allConfirmed ? 'ready' : 'confirming';
        if (group.status !== target) {
            group.status = target;
            group.updatedAt = Date.now();
            await this.groupRepo.save(group);
            // Keep the in-memory routing cache in sync — otherwise
            // getRoutableGroupIdForAdmin + getPendingPartyFeeRoute see
            // a stale CONFIRMING status after the DB has already
            // promoted the party to READY, and shares keep falling
            // through to the pool-fee fallback.
            this.adminAddressCache.set(group.adminAddress, { groupId: group.id, status: target });
        }
    }
}
