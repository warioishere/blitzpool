// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { Inject, Injectable, forwardRef, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import {
    BlockpartyInvitationEntity,
    BlockpartyInvitationStatus,
} from '../ORM/blockparty/blockparty-invitation.entity';
import { BlockpartyService, BlockpartyServiceError } from './blockparty.service';
import { EmailService } from './email.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';

const TOKEN_BYTES = 32; // → 43-char base64url
const DEFAULT_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class InvitationServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface InvitationCreateInput {
    groupId: string;
    address: string;
    email: string;
    ttlDays?: number;
}

/**
 * Read-only invitation view. Includes the FULL splits snapshot of the
 * party (transparent confirmation) so the recipient sees not only their
 * own percentage but also what every other member is getting — defends
 * against an admin telling members "you get 30%" while entering 5%.
 */
export interface InvitationView {
    token: string;
    groupId: string;
    groupName: string;
    address: string;
    email: string;
    status: BlockpartyInvitationStatus;
    expiresAt: number;
    members: Array<{ address: string; percentBp: number; role: 'admin' | 'member'; confirmed: boolean }>;
    /** Pool fee percent at invitation time — caller can render "100% breakdown" deterministically. */
    poolFeePercent: number;
}

@Injectable()
export class BlockpartyInvitationService {

    private readonly logger = new Logger(BlockpartyInvitationService.name);

    constructor(
        @InjectRepository(BlockpartyInvitationEntity)
        private readonly invitationRepo: Repository<BlockpartyInvitationEntity>,
        @Inject(forwardRef(() => BlockpartyService))
        private readonly blockpartyService: BlockpartyService,
        private readonly emailService: EmailService,
        private readonly config: ConfigService,
    ) {}

    private generateToken(): string {
        return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    }

    /**
     * Mint a directed invitation for the prospective member. Called from
     * the controller after BlockpartyService.addMember has persisted the
     * (unconfirmed) member row. Returns the plain token — surface this
     * to the admin exactly once.
     */
    async createInvitation(input: InvitationCreateInput): Promise<{ invitation: BlockpartyInvitationEntity; token: string }> {
        const normalizedAddress = normalizeBtcAddress(input.address);
        if (!normalizedAddress) {
            throw new InvitationServiceError('invalid-address', 'Address required');
        }
        const ttlDays = Math.max(1, Math.min(30, input.ttlDays ?? DEFAULT_TTL_DAYS));

        const token = this.generateToken();
        const now = Date.now();
        const normalizedEmail = input.email.trim().toLowerCase();
        // Keep at most one invitation row per (groupId, address) — the
        // invitation is a per-pair artifact, not a per-attempt log.
        // Each resend reuses the existing row (flipping status back to
        // pending with a fresh token + expiry) instead of minting new
        // rows that pile up in the admin's pending list. Lost-token
        // recovery is handled by the caller (resendInvitation / admin
        // batch) which additionally clears the member's onboarding
        // state so the next accept re-mints a BPM-... token.
        let invitation = await this.invitationRepo.findOne({
            where: { groupId: input.groupId, address: normalizedAddress },
        });
        if (invitation) {
            // Active pending row that hasn't expired yet: refuse the
            // re-mint to surface the duplicate-invite path correctly.
            // resendInvitation Case 1 handles same-token resend without
            // touching createInvitation, so this only fires when the
            // admin tries to fresh-invite an address that's already in
            // flight.
            if (invitation.status === 'pending' && invitation.expiresAt > now) {
                throw new InvitationServiceError(
                    'invitation-pending',
                    'A pending invitation for this address already exists — revoke or wait for the response first',
                );
            }
            invitation.token = token;
            invitation.email = normalizedEmail;
            invitation.status = 'pending';
            invitation.expiresAt = now + ttlDays * MS_PER_DAY;
            invitation.respondedAt = null;
            await this.invitationRepo.save(invitation);
        } else {
            invitation = await this.invitationRepo.save(this.invitationRepo.create({
                token,
                groupId: input.groupId,
                address: normalizedAddress,
                email: normalizedEmail,
                status: 'pending',
                expiresAt: now + ttlDays * MS_PER_DAY,
                respondedAt: null,
            }));
        }

        // Send the invitation email — the link delivery mirror of
        // pplns-group-invitation. Group context is fetched fresh so the
        // email shows the current party name + inviter (admin) address.
        // Errors propagate so the admin's UI flow surfaces SMTP issues
        // immediately; the invitation row persists either way, so
        // re-trying just resends from the existing row (admin can
        // revoke + re-invite if needed).
        const group = await this.blockpartyService.getGroup(input.groupId);
        if (group) {
            const baseUrl = this.poolBaseUrl();
            try {
                await this.emailService.sendInvitation({
                    to: normalizedEmail,
                    address: normalizedAddress,
                    groupName: group.name,
                    inviterAddress: group.adminAddress,
                    // UI uses HashLocationStrategy — path goes in the
                    // fragment. /blockparty/invite/:token is the public
                    // landing page (BlockpartyInviteComponent).
                    inviteUrl: `${baseUrl}/#/blockparty/invite/${token}`,
                    expiresAt: new Date(invitation.expiresAt),
                });
            } catch (err) {
                throw new InvitationServiceError(
                    'email-send-failed',
                    (err as Error)?.message ?? 'Email send failed',
                );
            }
        }

        return { invitation, token };
    }

    private poolBaseUrl(): string {
        const url = this.config.get<string>('POOL_BASE_URL');
        if (!url) {
            throw new InvitationServiceError('config-missing', 'POOL_BASE_URL is not set');
        }
        return url.replace(/\/+$/, '');
    }

    async getByToken(token: string): Promise<BlockpartyInvitationEntity | null> {
        return this.invitationRepo.findOneBy({ token });
    }

    /** All invitations issued by a party. Used by the admin dashboard. */
    async listForGroup(groupId: string): Promise<BlockpartyInvitationEntity[]> {
        return this.invitationRepo.find({ where: { groupId }, order: { createdAt: 'DESC' } });
    }

    /**
     * Build the redacted view served at /api/blockparty/invite/:token.
     * Includes the full splits so the prospective member can verify the
     * deal they're being invited into before clicking accept.
     */
    async getInvitationView(token: string): Promise<InvitationView | null> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation) return null;

        const group = await this.blockpartyService.getGroup(invitation.groupId);
        if (!group) return null;

        const members = await this.blockpartyService.listMembers(invitation.groupId);
        const poolFeePercent = this.blockpartyService.getPoolFeePercent();
        return {
            token: invitation.token,
            groupId: invitation.groupId,
            groupName: group.name,
            address: invitation.address,
            email: invitation.email,
            status: this.computeEffectiveStatus(invitation),
            expiresAt: invitation.expiresAt,
            members: members.map(m => ({
                address: m.address,
                percentBp: m.percentBp,
                role: m.role,
                confirmed: m.confirmedAt != null,
            })),
            poolFeePercent,
        };
    }

    /**
     * Returns the persistent member token minted on first accept. Surface
     * to the recipient exactly once — they need it for re-confirmations
     * (when admin edits splits) and for gated read access on the member
     * dashboard. Null on idempotent re-accept (token already minted).
     */
    async accept(token: string): Promise<{ memberToken: string | null }> {
        const invitation = await this.requirePending(token);

        // Mark the member confirmed first — if that fails (e.g. party
        // already ACTIVE or DISSOLVED), the invitation stays 'pending'
        // and the admin can intervene. If markMemberConfirmed succeeds
        // but the invitation update below fails, the member is confirmed
        // anyway, which is the safer side to err on (idempotent retry
        // will flip the invitation eventually).
        let memberToken: string | null = null;
        try {
            const result = await this.blockpartyService.markMemberConfirmed(invitation.groupId, invitation.address);
            memberToken = result.memberToken;
        } catch (err) {
            if (err instanceof BlockpartyServiceError) {
                throw new InvitationServiceError(err.code, err.message);
            }
            throw err;
        }

        invitation.status = 'accepted';
        invitation.respondedAt = Date.now();
        await this.invitationRepo.save(invitation);
        return { memberToken };
    }

    async decline(token: string): Promise<void> {
        const invitation = await this.requirePending(token);
        invitation.status = 'declined';
        invitation.respondedAt = Date.now();
        await this.invitationRepo.save(invitation);
    }

    /**
     * Re-deliver the invitation email for a given (groupId, address).
     *
     * Three cases:
     *   1. A still-pending non-expired invite exists → re-send the same
     *      token via email (no new row). Recipient can use the URL from
     *      either email.
     *   2. A pending-but-expired invite exists → mark it expired, mint a
     *      fresh token, send email.
     *   3. No pending invite (e.g. member was declined or revoked) →
     *      mint a fresh one.
     *
     * Admin-token gating happens at the controller layer.
     */
    async resendInvitation(
        groupId: string,
        address: string,
        ttlDays?: number,
    ): Promise<{ token: string; resent: boolean }> {
        const normalizedAddress = normalizeBtcAddress(address);
        if (!normalizedAddress) {
            throw new InvitationServiceError('invalid-address', 'Address required');
        }

        const existing = await this.invitationRepo.findOne({
            where: { groupId, address: normalizedAddress, status: 'pending' },
        });

        // Case 1: still-pending + not expired → re-send same token.
        if (existing && existing.expiresAt > Date.now()) {
            const group = await this.blockpartyService.getGroup(groupId);
            if (!group) throw new InvitationServiceError('not-found', 'Blockparty not found');
            const baseUrl = this.poolBaseUrl();
            try {
                await this.emailService.sendInvitation({
                    to: existing.email,
                    address: normalizedAddress,
                    groupName: group.name,
                    inviterAddress: group.adminAddress,
                    inviteUrl: `${baseUrl}/#/blockparty/invite/${existing.token}`,
                    expiresAt: new Date(existing.expiresAt),
                });
            } catch (err) {
                throw new InvitationServiceError(
                    'email-send-failed',
                    (err as Error)?.message ?? 'Email send failed',
                );
            }
            return { token: existing.token, resent: true };
        }

        // Case 2: pending-but-expired → mark expired and fall through.
        if (existing && existing.expiresAt <= Date.now()) {
            existing.status = 'expired';
            existing.respondedAt = Date.now();
            await this.invitationRepo.save(existing);
        }

        // Case 2 cont. / Case 3: mint a fresh invitation. The email
        // comes from the member's verified binding (createInvitation
        // re-looks it up internally).
        const member = await this.blockpartyService.listMembers(groupId);
        const row = member.find(m => m.address === normalizedAddress);
        if (!row) {
            throw new InvitationServiceError('not-member', 'Address is not a member of this Blockparty');
        }
        // Lost-token recovery: clear the member's previous onboarding
        // state so the accept flow re-mints a fresh BPM-... token. Safe
        // for first-time invites too (no-ops when nothing was set).
        await this.blockpartyService.resetMemberOnboarding(groupId, normalizedAddress);
        const { token } = await this.createInvitation({
            groupId,
            address: normalizedAddress,
            email: row.email,
            ttlDays,
        });
        return { token, resent: false };
    }

    async revoke(groupId: string, token: string): Promise<void> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation || invitation.groupId !== groupId) {
            throw new InvitationServiceError('invitation-not-found', 'Invitation not found for this Blockparty');
        }
        if (invitation.status !== 'pending') {
            throw new InvitationServiceError('invitation-not-pending', `Invitation is ${invitation.status} — cannot revoke`);
        }
        // Revoking = letting it expire immediately. No 'revoked' status because
        // for v1 we only support directed invites; the partial unique index keys
        // on status='pending', so flipping to 'expired' frees a new pending row.
        invitation.status = 'expired';
        invitation.respondedAt = Date.now();
        await this.invitationRepo.save(invitation);
    }

    private async requirePending(token: string): Promise<BlockpartyInvitationEntity> {
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation) {
            throw new InvitationServiceError('invitation-not-found', 'Invitation not found');
        }
        const effective = this.computeEffectiveStatus(invitation);
        if (effective !== 'pending') {
            throw new InvitationServiceError(
                'invitation-not-pending',
                `Invitation is ${effective} — no longer actionable`,
            );
        }
        return invitation;
    }

    private computeEffectiveStatus(invitation: BlockpartyInvitationEntity): BlockpartyInvitationStatus {
        if (invitation.status !== 'pending') return invitation.status;
        if (invitation.expiresAt < Date.now()) return 'expired';
        return 'pending';
    }
}
