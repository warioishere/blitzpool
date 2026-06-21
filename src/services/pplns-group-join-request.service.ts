// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PplnsGroupJoinRequestEntity } from '../ORM/pplns-group/pplns-group-join-request.entity';
import { PplnsGroupMemberEntity } from '../ORM/pplns-group/pplns-group-member.entity';
import { GroupService } from './group.service';
import { AddressEmailService } from './address-email.service';
import { EmailService } from './email.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';

const MESSAGE_MAX_LENGTH = 500;
/** Cap on simultaneously-pending join requests across all groups for one address. */
const MAX_PENDING_PER_ADDRESS = 10;
/** Hours of cooldown after a rejected request before the same (group, address) pair can re-request. */
const REJECT_COOLDOWN_HOURS = 24;
/** Auto-expire join requests that languished as 'pending' for this long (admin abandoned the panel). */
const PENDING_EXPIRY_DAYS = 30;

export class JoinRequestServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

/**
 * Public-directory join requests. The complement to invitations:
 *   - Invitation = admin-initiated, pre-binds the address (directed) or
 *                  is shareable (open).
 *   - Join request = user-initiated, address comes from the requester,
 *                    admin reviews + approves/rejects.
 *
 * Same trust anchor as invitations: the requesting address must have a
 * verified email binding. The email is snapshotted onto the request row
 * at create time so approve/reject notifications reach the same inbox
 * even if the user later rebinds.
 *
 * Rate limits (multi-layer):
 *   1. DB-level — unique partial index on (groupId, address) WHERE status='pending'
 *      means the same (group, address) pair can have only one pending row.
 *   2. Service-level — global cap of MAX_PENDING_PER_ADDRESS pending across
 *      all groups for one address (prevents an attacker farming verified
 *      emails and then spraying admins with pending requests).
 *   3. Service-level — REJECT_COOLDOWN_HOURS after a reject before the same
 *      (group, address) can request again.
 */
@Injectable()
export class PplnsGroupJoinRequestService {

    private readonly logger = new Logger(PplnsGroupJoinRequestService.name);

    constructor(
        @InjectRepository(PplnsGroupJoinRequestEntity)
        private readonly requestRepo: Repository<PplnsGroupJoinRequestEntity>,
        @InjectRepository(PplnsGroupMemberEntity)
        private readonly memberRepo: Repository<PplnsGroupMemberEntity>,
        private readonly groupService: GroupService,
        private readonly addressEmailService: AddressEmailService,
        private readonly emailService: EmailService,
        private readonly config: ConfigService,
    ) {}

    /**
     * Create a join request. Public — no admin-token check. Validation chain:
     *   - Group exists, is public, not dissolved
     *   - Address shape is valid + has a verified email
     *   - Address isn't already a member of any group
     *   - Address isn't over the global pending cap
     *   - No (group, address) row currently in cooldown
     *   - The DB unique partial index does the final consistency check
     */
    async createJoinRequest(
        groupId: string,
        address: string,
        message: string | null | undefined,
    ): Promise<PplnsGroupJoinRequestEntity> {
        const group = await this.groupService.getGroup(groupId);
        if (!group || group.dissolvedAt) {
            throw new JoinRequestServiceError('not-found', 'Group not found');
        }
        if (!group.isPublic) {
            // Don't leak existence of private groups via this endpoint.
            // 'not-found' rather than 'forbidden' so the caller can't probe
            // for "private but exists" responses.
            throw new JoinRequestServiceError('not-found', 'Group not found');
        }

        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new JoinRequestServiceError('invalid-address', 'A valid Bitcoin address is required');
        }

        const binding = await this.addressEmailService.getVerified(normalized);
        if (!binding) {
            throw new JoinRequestServiceError(
                'email-not-verified',
                'This address has no verified email. Register and verify your email first.',
            );
        }

        // Already a member?
        const existingMember = await this.memberRepo.findOneBy({ address: normalized });
        if (existingMember) {
            if (existingMember.groupId === groupId) {
                throw new JoinRequestServiceError('already-member', 'Address is already a member of this group');
            }
            throw new JoinRequestServiceError('address-in-group', 'Address is already a member of another group');
        }

        // Global cap on pending across all groups
        const pendingForAddr = await this.requestRepo.count({
            where: { address: normalized, status: 'pending' },
        });
        if (pendingForAddr >= MAX_PENDING_PER_ADDRESS) {
            throw new JoinRequestServiceError(
                'too-many-pending',
                `You already have ${pendingForAddr} pending join requests; resolve some before adding more.`,
            );
        }

        // Reject cooldown — same (group, address) can't re-request within
        // REJECT_COOLDOWN_HOURS of being declined.
        const recentReject = await this.requestRepo.findOne({
            where: { groupId, address: normalized, status: 'rejected' },
            order: { decidedAt: 'DESC' },
        });
        if (recentReject?.decidedAt) {
            const elapsedHours = (Date.now() - recentReject.decidedAt) / (60 * 60 * 1000);
            if (elapsedHours < REJECT_COOLDOWN_HOURS) {
                throw new JoinRequestServiceError(
                    'reject-cooldown',
                    `Please wait ${Math.ceil(REJECT_COOLDOWN_HOURS - elapsedHours)} more hour(s) before re-requesting.`,
                );
            }
        }

        const trimmedMessage = (message ?? '').toString().trim().slice(0, MESSAGE_MAX_LENGTH) || null;

        try {
            return await this.requestRepo.save(this.requestRepo.create({
                groupId,
                address: normalized,
                email: binding.email,
                message: trimmedMessage,
                status: 'pending',
            }));
        } catch (e) {
            // The unique partial index throws a Postgres unique-violation
            // (23505) if a pending row already exists for (groupId, address).
            // Surface as a clean 'request-pending' instead of 500.
            if ((e as any)?.code === '23505') {
                throw new JoinRequestServiceError('request-pending', 'A join request for this address is already pending');
            }
            throw e;
        }
    }

    /**
     * List join requests for a group. Admin-token gated. Default returns
     * only pending; pass `includeDecided=true` to also see recently
     * approved/rejected rows for audit.
     */
    async listForGroup(
        groupId: string,
        adminToken: string | undefined,
        opts: { includeDecided?: boolean } = {},
    ): Promise<PplnsGroupJoinRequestEntity[]> {
        await this.groupService.requireAdminToken(groupId, adminToken);
        const where = opts.includeDecided
            ? { groupId }
            : { groupId, status: 'pending' as const };
        return this.requestRepo.find({
            where,
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Approve a pending request — creates the membership and notifies the
     * miner by email. Admin-token gated. Idempotent only by virtue of the
     * pending-status guard: a second approve on the same id returns 'not-found'.
     */
    async approveRequest(
        groupId: string,
        requestId: string,
        adminToken: string | undefined,
    ): Promise<void> {
        const group = await this.groupService.requireAdminToken(groupId, adminToken);
        const request = await this.requestRepo.findOneBy({ id: requestId, groupId, status: 'pending' });
        if (!request) {
            throw new JoinRequestServiceError('not-found', 'Pending join request not found');
        }
        if (group.dissolvedAt) {
            throw new JoinRequestServiceError('group-dissolved', 'Group has been dissolved');
        }

        // Last-mile checks — the user could have joined another group between
        // submitting the request and the admin approving it.
        const existingMember = await this.memberRepo.findOneBy({ address: request.address });
        if (existingMember && existingMember.groupId !== groupId) {
            // Mark the request rejected (audit) so it doesn't keep showing up
            // as pending in the admin UI.
            request.status = 'rejected';
            request.decidedAt = Date.now();
            request.decidedByAdminTokenHash = this.hashToken(adminToken!);
            await this.requestRepo.save(request);
            throw new JoinRequestServiceError('address-in-group', 'Address joined another group in the meantime');
        }
        if (!existingMember) {
            await this.groupService.addMemberWithoutAdmin(groupId, request.address);
        }
        // else: member already in this group (manual add by admin?) — fall through
        //       to mark the request approved so it disappears from the panel.

        request.status = 'approved';
        request.decidedAt = Date.now();
        request.decidedByAdminTokenHash = this.hashToken(adminToken!);
        await this.requestRepo.save(request);

        // Best-effort email; service swallows + logs SMTP errors so the
        // approval transaction isn't tied to email-server availability.
        const baseUrl = this.poolBaseUrl();
        await this.emailService.sendJoinRequestApproved({
            to: request.email,
            address: request.address,
            groupName: group.name,
            groupUrl: `${baseUrl}/#/app/${request.address}/payout-group`,
        });
    }

    /**
     * Reject a pending request. No reason text — the admin UI is intentionally
     * minimal (a comment field would invite drama). Admin-token gated.
     */
    async rejectRequest(
        groupId: string,
        requestId: string,
        adminToken: string | undefined,
    ): Promise<void> {
        const group = await this.groupService.requireAdminToken(groupId, adminToken);
        const request = await this.requestRepo.findOneBy({ id: requestId, groupId, status: 'pending' });
        if (!request) {
            throw new JoinRequestServiceError('not-found', 'Pending join request not found');
        }

        request.status = 'rejected';
        request.decidedAt = Date.now();
        request.decidedByAdminTokenHash = this.hashToken(adminToken!);
        await this.requestRepo.save(request);

        const baseUrl = this.poolBaseUrl();
        await this.emailService.sendJoinRequestRejected({
            to: request.email,
            address: request.address,
            groupName: group.name,
            groupUrl: `${baseUrl}/#/groups/public`,
        });
    }

    /**
     * List the current user's own pending requests across all groups —
     * drives the "you have a request pending" badge on directory pages.
     * Public, no auth.
     */
    async listForAddress(address: string): Promise<{
        groupId: string;
        groupName: string;
        status: 'pending';
        createdAt: number;
    }[]> {
        const normalized = normalizeBtcAddress(address);
        if (!normalized) return [];
        const rows = await this.requestRepo.find({
            where: { address: normalized, status: 'pending' },
            order: { createdAt: 'DESC' },
        });
        const results: any[] = [];
        for (const r of rows) {
            const group = await this.groupService.getGroup(r.groupId);
            if (!group || group.dissolvedAt) continue;
            results.push({
                groupId: r.groupId,
                groupName: group.name,
                status: 'pending',
                createdAt: r.createdAt,
            });
        }
        return results;
    }

    /**
     * Periodic expiry for stale pending requests — covers the case where
     * the admin abandons the panel for weeks. Daily cron is fine; the
     * count of expirable rows is small.
     */
    @Interval(24 * 60 * 60 * 1000)
    async expireStale(): Promise<number> {
        try {
            const cutoff = Date.now() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
            const result = await this.requestRepo.update(
                { status: 'pending', createdAt: LessThan(cutoff) },
                { status: 'expired' },
            );
            const n = result.affected ?? 0;
            if (n > 0) this.logger.log(`Expired ${n} stale join requests`);
            return n;
        } catch (err) {
            this.logger.warn(`expireStale failed: ${(err as Error).message}`);
            return 0;
        }
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private poolBaseUrl(): string {
        const url = this.config.get<string>('POOL_BASE_URL');
        return (url ?? '').replace(/\/+$/, '');
    }
}
