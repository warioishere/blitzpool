// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from '../ORM/pplns-group/pplns-group-member.entity';
import { PplnsGroupInvitationEntity } from '../ORM/pplns-group/pplns-group-invitation.entity';
import { GroupService, GroupServiceError } from './group.service';
import { AddressEmailService } from './address-email.service';
import { EmailService } from './email.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';
import { maskEmail } from '../utils/email-mask.utils';

const INVITATION_TTL_DAYS = 7;

/**
 * Allowed TTL presets for open invite links. Mapped to milliseconds.
 * Kept short and explicit — admins shouldn't be passing arbitrary
 * durations (a year-long link is a footgun).
 */
export const OPEN_INVITE_TTL_PRESETS = {
    '1h':  60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
} as const;
export type OpenInviteTtl = keyof typeof OPEN_INVITE_TTL_PRESETS;

export class InvitationServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface CreatedInvitation {
    token: string;
    email: string;
    expiresAt: number;
}

/**
 * Two-phase membership for payout groups: an admin creates an invitation
 * (this service), an email is sent to the address holder, and they accept
 * (or decline) via a tokenized link. Only on accept does the address
 * actually become a member of the group.
 *
 * The trust anchor is the verified email bound to the address — without it
 * an admin cannot create an invitation, and without the email-delivered
 * token the invitation cannot be accepted. This blocks the silent-add
 * attack where an admin would otherwise route an unsuspecting miner's
 * payouts into their own group.
 */
@Injectable()
export class PplnsGroupInvitationService {

    private readonly logger = new Logger(PplnsGroupInvitationService.name);

    constructor(
        @InjectRepository(PplnsGroupInvitationEntity)
        private readonly invitationRepo: Repository<PplnsGroupInvitationEntity>,
        @InjectRepository(PplnsGroupMemberEntity)
        private readonly memberRepo: Repository<PplnsGroupMemberEntity>,
        private readonly groupService: GroupService,
        private readonly addressEmailService: AddressEmailService,
        private readonly emailService: EmailService,
        private readonly config: ConfigService,
    ) {}

    /**
     * Create + send a single invitation. Admin token is verified by
     * GroupService; we then check the invited address has a verified
     * email binding before sending.
     */
    async createInvitation(
        groupId: string,
        address: string,
        adminToken: string | undefined,
    ): Promise<CreatedInvitation> {
        const group = await this.groupService.requireAdminToken(groupId, adminToken);

        const normalizedAddress = normalizeBtcAddress(address);
        if (!normalizedAddress) throw new InvitationServiceError('invalid-address', 'Address required');
        address = normalizedAddress;

        // Already a member? Skip.
        const existingMember = await this.memberRepo.findOneBy({ address });
        if (existingMember) {
            if (existingMember.groupId === groupId) {
                throw new InvitationServiceError('already-member', 'Address is already in this group');
            }
            throw new InvitationServiceError('address-in-group', 'Address is already a member of another group');
        }

        // Pending invitation already in flight? Skip.
        const pending = await this.invitationRepo.findOne({
            where: { groupId, address, status: 'pending', inviteType: 'directed' },
        });
        if (pending && pending.expiresAt > Date.now()) {
            throw new InvitationServiceError('invitation-pending', 'An invitation for this address is already pending');
        }

        // Email-verified address? Mandatory.
        const binding = await this.addressEmailService.getVerified(address);
        if (!binding) {
            throw new InvitationServiceError(
                'email-not-verified',
                'Address has no verified email. Ask the recipient to bind one in their dashboard first.',
            );
        }

        // Mark any expired pending invitation as expired (cleanup).
        if (pending && pending.expiresAt <= Date.now()) {
            pending.status = 'expired';
            await this.invitationRepo.save(pending);
        }

        const token = this.generateToken();
        const expiresAt = Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
        const invitation = await this.invitationRepo.save(this.invitationRepo.create({
            token,
            groupId,
            address,
            email: binding.email,
            status: 'pending',
            inviteType: 'directed',
            expiresAt,
        }));

        // Email link goes to the UI invitation page, not directly at the
        // accept/decline endpoints — the recipient sees the group context
        // and confirms there with an explicit button click. This protects
        // against accidental accept/decline from email-preview link
        // pre-fetchers or one-tap email-client gestures.
        const baseUrl = this.poolBaseUrl();
        await this.emailService.sendInvitation({
            to: binding.email,
            address,
            groupName: group.name,
            inviterAddress: group.creatorAddress,
            // UI uses HashLocationStrategy — path has to be in the
            // fragment. See address-email.service.ts for the same trap.
            inviteUrl: `${baseUrl}/#/invite/${token}`,
            expiresAt: new Date(invitation.expiresAt),
        });

        return { token: invitation.token, email: binding.email, expiresAt: invitation.expiresAt };
    }

    /**
     * Look up an invitation by its public token. Used by the accept/decline
     * UI to render the group context before the user commits.
     */
    async getByToken(token: string): Promise<{
        invitation: PplnsGroupInvitationEntity;
        group: PplnsGroupEntity;
    } | null> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation) return null;
        // Open invites use a different public endpoint (getOpenInvitePublic);
        // hide them from the directed-invite landing page, which expects
        // address + email to be populated.
        if (invitation.inviteType === 'open') return null;
        const group = await this.groupService.getGroup(invitation.groupId);
        if (!group || group.dissolvedAt) return null;
        return { invitation, group };
    }

    /**
     * Accept an invitation. Idempotent on the resulting membership: if the
     * token has already been accepted, surfaces 'already-accepted' rather
     * than creating a duplicate member.
     */
    async accept(token: string): Promise<PplnsGroupMemberEntity> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation) {
            throw new InvitationServiceError('not-found', 'Invitation unknown or already consumed');
        }
        // Open invites flow through acceptOpenInvite() (which takes the
        // address from the user). Calling accept() on an open token would
        // crash on the null address — surface a clean error instead.
        if (invitation.inviteType === 'open') {
            throw new InvitationServiceError('not-found', 'Invitation unknown or already consumed');
        }
        if (invitation.status === 'accepted') {
            const member = await this.memberRepo.findOneBy({
                groupId: invitation.groupId,
                address: invitation.address,
            });
            if (member) return member;
            throw new InvitationServiceError('inconsistent', 'Invitation accepted but member missing — contact admin');
        }
        if (invitation.status === 'declined') {
            throw new InvitationServiceError('already-declined', 'Invitation was declined');
        }
        if (invitation.expiresAt < Date.now()) {
            invitation.status = 'expired';
            await this.invitationRepo.save(invitation);
            throw new InvitationServiceError('expired', 'Invitation has expired');
        }

        // The group may have been dissolved between invite-send and accept.
        // addMemberWithoutAdmin would happily write a member row into a
        // dissolved group (rebuildCache filters it out but the stale DB
        // row remains, causing UI/stratum inconsistency). Block it here.
        const group = await this.groupService.getGroup(invitation.groupId);
        if (!group || group.dissolvedAt) {
            throw new InvitationServiceError('group-dissolved', 'Group no longer exists');
        }

        // Invitation rows were stored with a normalized address (bech32
        // lowercased) but older data from before this change might not
        // be — re-normalize here for the lookup so legacy rows still
        // resolve correctly.
        const normalizedInvitedAddress = normalizeBtcAddress(invitation.address);

        // Make sure the address didn't join another group in the meantime.
        const existingMember = await this.memberRepo.findOneBy({ address: normalizedInvitedAddress });
        if (existingMember && existingMember.groupId !== invitation.groupId) {
            throw new InvitationServiceError('address-in-group', 'Address is now in another group — invitation invalid');
        }
        if (existingMember && existingMember.groupId === invitation.groupId) {
            // Defensive — user is already a member somehow (manual add?), just
            // mark invitation accepted and return the existing member.
            invitation.status = 'accepted';
            invitation.respondedAt = Date.now();
            await this.invitationRepo.save(invitation);
            return existingMember;
        }

        const member = await this.groupService.addMemberWithoutAdmin(
            invitation.groupId,
            normalizedInvitedAddress,
        );

        invitation.status = 'accepted';
        invitation.respondedAt = Date.now();
        await this.invitationRepo.save(invitation);
        return member;
    }

    /**
     * Decline an invitation. No auth — anyone with the token can decline.
     * That's intentional: there's no incentive for a third party to decline
     * on someone's behalf, and it lets the recipient dispose of the
     * invitation even if they've lost access to the email account that
     * received it.
     */
    async decline(token: string): Promise<void> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation) {
            throw new InvitationServiceError('not-found', 'Invitation unknown or already consumed');
        }
        if (invitation.status === 'pending') {
            invitation.status = 'declined';
            invitation.respondedAt = Date.now();
            await this.invitationRepo.save(invitation);
        }
    }

    /**
     * List pending invitations for an address — drives the "you have
     * pending invitations" banner on the dashboard.
     *
     * Deliberately does NOT include the invitation token. /app/:address
     * is a public URL with no authentication, so exposing the token in
     * this response would let any visitor construct /invite/:token and
     * accept on the address holder's behalf — defeating the whole point
     * of the email-based trust anchor. Instead we return a masked email
     * hint so the user knows WHICH inbox to check, and they accept by
     * clicking the link in the email itself.
     */
    async listPendingForAddress(address: string): Promise<{
        groupId: string;
        groupName: string;
        inviterAddress: string;
        maskedEmail: string;
        createdAt: number;
        expiresAt: number;
    }[]> {
        // Normalise (lowercase bech32) so the lookup key matches what
        // createInvitation stored. Without this, a banner request from
        // /api/pplns/invitations/by-address/BC1Q... silently misses the
        // pending row that was created against bc1q... by the admin.
        const normalized = normalizeBtcAddress(address);
        if (!normalized) return [];
        // Open invites don't have a pre-bound address — they never surface
        // in this banner. Restrict to directed.
        const rows = await this.invitationRepo.find({
            where: { address: normalized, status: 'pending', inviteType: 'directed' },
            order: { createdAt: 'DESC' },
        });
        const now = Date.now();
        const result: any[] = [];
        for (const row of rows) {
            if (row.expiresAt < now) continue;
            const group = await this.groupService.getGroup(row.groupId);
            if (!group || group.dissolvedAt) continue;
            result.push({
                groupId: row.groupId,
                groupName: group.name,
                inviterAddress: group.creatorAddress,
                maskedEmail: maskEmail(row.email),
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
            });
        }
        return result;
    }

    /**
     * List pending invitations for a group — admin uses this to see who's
     * been invited but hasn't responded yet, and to cancel if needed.
     */
    async listPendingForGroup(groupId: string): Promise<PplnsGroupInvitationEntity[]> {
        // Directed-only — open invites get their own listing endpoint
        // because they have different fields (no pre-bound address/email)
        // and lifecycle (multi-use, no accept/decline state).
        const rows = await this.invitationRepo.find({
            where: { groupId, status: 'pending', inviteType: 'directed' },
            order: { createdAt: 'DESC' },
        });
        const now = Date.now();
        return rows.filter(r => r.expiresAt >= now);
    }

    /**
     * Cancel the pending invitation for an address in a group. Identified
     * by (groupId, address) rather than by token, so the admin never sees
     * the secret token — that lives only in the email body.
     */
    async cancelInvitationByAddress(
        groupId: string,
        address: string,
        adminToken: string | undefined,
    ): Promise<void> {
        await this.groupService.requireAdminToken(groupId, adminToken);
        const invitation = await this.invitationRepo.findOne({
            where: { groupId, address, status: 'pending', inviteType: 'directed' },
        });
        if (!invitation) {
            throw new InvitationServiceError('not-found', 'No pending invitation for this address in this group');
        }
        await this.invitationRepo.delete({ token: invitation.token });
    }

    // ── Open invitation links ─────────────────────────────────────────
    //
    // Admin-shareable links to be posted in a community channel. Anyone
    // with a verified email binding for their address can claim them
    // before the TTL expires. Single active link per group — generating
    // a new one revokes the previous one in the same transaction.

    /**
     * Create a fresh open-invite link, atomically revoking any previously
     * active one for the same group. Returns the new token + expiry; the
     * caller (controller) is responsible for assembling the public URL.
     */
    async createOpenInvite(
        groupId: string,
        ttl: OpenInviteTtl,
        adminToken: string | undefined,
        approvalRequired: boolean = false,
    ): Promise<{ token: string; expiresAt: number; approvalRequired: boolean }> {
        await this.groupService.requireAdminToken(groupId, adminToken);

        const ttlMs = OPEN_INVITE_TTL_PRESETS[ttl];
        if (!ttlMs) {
            throw new InvitationServiceError('invalid-ttl', `ttl must be one of: ${Object.keys(OPEN_INVITE_TTL_PRESETS).join(', ')}`);
        }

        const token = this.generateToken();
        const expiresAt = Date.now() + ttlMs;

        // Atomic replace: same transaction both revokes old + inserts new
        // so two concurrent admin clicks can't race to leave two active
        // open invites for the same group.
        await this.invitationRepo.manager.transaction(async (em) => {
            const repo = em.getRepository(PplnsGroupInvitationEntity);
            await repo.update(
                { groupId, status: 'pending', inviteType: 'open' },
                { status: 'revoked', respondedAt: Date.now() },
            );
            await repo.save(repo.create({
                token,
                groupId,
                address: null,
                email: null,
                status: 'pending',
                inviteType: 'open',
                approvalRequired,
                expiresAt,
            }));
        });

        return { token, expiresAt, approvalRequired };
    }

    /**
     * Get the currently active (pending, not expired) open invite for a
     * group. Admin-token gated — the token is the live secret. Returns
     * null if no link is active or the previous one expired.
     */
    async getActiveOpenInvite(
        groupId: string,
        adminToken: string | undefined,
    ): Promise<{ token: string; expiresAt: number; createdAt: number; approvalRequired: boolean } | null> {
        await this.groupService.requireAdminToken(groupId, adminToken);
        const row = await this.invitationRepo.findOne({
            where: { groupId, inviteType: 'open', status: 'pending' },
            order: { createdAt: 'DESC' },
        });
        if (!row) return null;
        if (row.expiresAt < Date.now()) return null;
        return {
            token: row.token,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
            approvalRequired: row.approvalRequired,
        };
    }

    /**
     * Manually revoke the active open invite for a group. Idempotent —
     * no-op if no active link exists.
     */
    async revokeOpenInvite(
        groupId: string,
        adminToken: string | undefined,
    ): Promise<void> {
        await this.groupService.requireAdminToken(groupId, adminToken);
        await this.invitationRepo.update(
            { groupId, status: 'pending', inviteType: 'open' },
            { status: 'revoked', respondedAt: Date.now() },
        );
    }

    /**
     * Public lookup for the open-invite landing page. Returns just enough
     * to render the group context — no admin secrets, no member list.
     * Returns null if the token is unknown, wrong type, expired, revoked,
     * or the group has been dissolved.
     */
    async getOpenInvitePublic(token: string): Promise<{
        token: string;
        groupId: string;
        groupName: string;
        expiresAt: number;
        approvalRequired: boolean;
    } | null> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation || invitation.inviteType !== 'open') return null;
        if (invitation.status !== 'pending') return null;
        if (invitation.expiresAt < Date.now()) return null;
        const group = await this.groupService.getGroup(invitation.groupId);
        if (!group || group.dissolvedAt) return null;
        return {
            token: invitation.token,
            groupId: invitation.groupId,
            groupName: group.name,
            expiresAt: invitation.expiresAt,
            approvalRequired: invitation.approvalRequired,
        };
    }

    /**
     * Accept an open invite by binding it to a specific address. Multi-use:
     * the row stays 'pending' so other miners can also claim the link until
     * it expires. The trust anchor is the same as for directed invites —
     * the address must have a verified email binding.
     */
    async acceptOpenInvite(token: string, address: string): Promise<PplnsGroupMemberEntity> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation || invitation.inviteType !== 'open') {
            throw new InvitationServiceError('not-found', 'Open invitation unknown');
        }
        if (invitation.status !== 'pending') {
            // 'revoked' or 'expired' surface as 'expired' to the user — both
            // mean the same thing functionally (link is dead).
            throw new InvitationServiceError('expired', 'Open invitation no longer valid');
        }
        if (invitation.expiresAt < Date.now()) {
            invitation.status = 'expired';
            await this.invitationRepo.save(invitation);
            throw new InvitationServiceError('expired', 'Open invitation has expired');
        }
        // Approval-required mode: refuse to auto-add. The frontend MUST route
        // the joiner through the join-request flow instead. Backend-enforced
        // because the public accept endpoint can otherwise be hit directly
        // via curl, bypassing any frontend gate.
        if (invitation.approvalRequired) {
            throw new InvitationServiceError(
                'approval-required',
                'This link requires admin approval — submit a join request instead.',
            );
        }

        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new InvitationServiceError('invalid-address', 'A valid Bitcoin address is required');
        }

        // Email verification anchor — same as directed flow. Without this
        // an open link in a public channel is worth nothing on its own.
        const binding = await this.addressEmailService.getVerified(normalized);
        if (!binding) {
            throw new InvitationServiceError(
                'email-not-verified',
                'This address has no verified email. Register and verify your email first.',
            );
        }

        const group = await this.groupService.getGroup(invitation.groupId);
        if (!group || group.dissolvedAt) {
            throw new InvitationServiceError('group-dissolved', 'Group no longer exists');
        }

        // Already a member of this or another group? Surface clear errors
        // so the user knows why the join failed.
        const existingMember = await this.memberRepo.findOneBy({ address: normalized });
        if (existingMember && existingMember.groupId === invitation.groupId) {
            throw new InvitationServiceError('already-member', 'Address is already a member of this group');
        }
        if (existingMember && existingMember.groupId !== invitation.groupId) {
            throw new InvitationServiceError('address-in-group', 'Address is already a member of another group');
        }

        return this.groupService.addMemberWithoutAdmin(invitation.groupId, normalized);
    }

    /**
     * Periodic cleanup — flips expired pending invitations to 'expired'.
     * Fires hourly via @Interval. The method is also safe to call directly
     * (tests / admin endpoints).
     */
    @Interval(60 * 60 * 1000)
    async expireOld(): Promise<number> {
        try {
            const result = await this.invitationRepo.update(
                { status: 'pending', expiresAt: LessThan(Date.now()) },
                { status: 'expired' },
            );
            const n = result.affected ?? 0;
            if (n > 0) this.logger.log(`Marked ${n} expired invitations`);
            return n;
        } catch (err) {
            this.logger.warn(`expireOld failed: ${(err as Error).message}`);
            return 0;
        }
    }

    private generateToken(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private poolBaseUrl(): string {
        const url = this.config.get<string>('POOL_BASE_URL');
        if (!url) {
            throw new InvitationServiceError('config-missing', 'POOL_BASE_URL is not set');
        }
        return url.replace(/\/+$/, '');
    }
}

