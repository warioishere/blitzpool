import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from '../ORM/pplns-group/pplns-group-member.entity';
import { PplnsGroupInvitationEntity } from '../ORM/pplns-group/pplns-group-invitation.entity';
import { GroupService, GroupServiceError } from './group.service';
import { AddressEmailService } from './address-email.service';
import { EmailService } from './email.service';

const INVITATION_TTL_DAYS = 7;

export class InvitationServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface CreatedInvitation {
    token: string;
    email: string;
    expiresAt: Date;
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

        if (!address) throw new InvitationServiceError('invalid-address', 'Address required');

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
            where: { groupId, address, status: 'pending' },
        });
        if (pending && pending.expiresAt.getTime() > Date.now()) {
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
        if (pending && pending.expiresAt.getTime() <= Date.now()) {
            pending.status = 'expired';
            await this.invitationRepo.save(pending);
        }

        const token = this.generateToken();
        const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
        const invitation = await this.invitationRepo.save(this.invitationRepo.create({
            token,
            groupId,
            address,
            email: binding.email,
            status: 'pending',
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
            inviteUrl: `${baseUrl}/invite/${token}`,
            expiresAt: invitation.expiresAt,
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
        if (invitation.expiresAt.getTime() < Date.now()) {
            invitation.status = 'expired';
            await this.invitationRepo.save(invitation);
            throw new InvitationServiceError('expired', 'Invitation has expired');
        }

        // Make sure the address didn't join another group in the meantime.
        const existingMember = await this.memberRepo.findOneBy({ address: invitation.address });
        if (existingMember && existingMember.groupId !== invitation.groupId) {
            throw new InvitationServiceError('address-in-group', 'Address is now in another group — invitation invalid');
        }
        if (existingMember && existingMember.groupId === invitation.groupId) {
            // Defensive — user is already a member somehow (manual add?), just
            // mark invitation accepted and return the existing member.
            invitation.status = 'accepted';
            invitation.respondedAt = new Date();
            await this.invitationRepo.save(invitation);
            return existingMember;
        }

        const member = await this.groupService.addMemberWithoutAdmin(
            invitation.groupId,
            invitation.address,
        );

        invitation.status = 'accepted';
        invitation.respondedAt = new Date();
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
            invitation.respondedAt = new Date();
            await this.invitationRepo.save(invitation);
        }
    }

    /**
     * List pending invitations for an address — drives the "you have
     * pending invitations" banner on the dashboard.
     */
    async listPendingForAddress(address: string): Promise<{
        token: string;
        groupId: string;
        groupName: string;
        inviterAddress: string;
        createdAt: Date;
        expiresAt: Date;
    }[]> {
        const rows = await this.invitationRepo.find({
            where: { address, status: 'pending' },
            order: { createdAt: 'DESC' },
        });
        const now = Date.now();
        const result: any[] = [];
        for (const row of rows) {
            if (row.expiresAt.getTime() < now) continue;
            const group = await this.groupService.getGroup(row.groupId);
            if (!group || group.dissolvedAt) continue;
            result.push({
                token: row.token,
                groupId: row.groupId,
                groupName: group.name,
                inviterAddress: group.creatorAddress,
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
        const rows = await this.invitationRepo.find({
            where: { groupId, status: 'pending' },
            order: { createdAt: 'DESC' },
        });
        const now = Date.now();
        return rows.filter(r => r.expiresAt.getTime() >= now);
    }

    async cancelInvitation(token: string, groupId: string, adminToken: string | undefined): Promise<void> {
        await this.groupService.requireAdminToken(groupId, adminToken);
        const invitation = await this.invitationRepo.findOneBy({ token });
        if (!invitation || invitation.groupId !== groupId) {
            throw new InvitationServiceError('not-found', 'Invitation not found in this group');
        }
        await this.invitationRepo.delete({ token });
    }

    /**
     * Periodic cleanup — flips expired pending invitations to 'expired'.
     */
    async expireOld(): Promise<number> {
        const result = await this.invitationRepo.update(
            { status: 'pending', expiresAt: LessThan(new Date()) },
            { status: 'expired' },
        );
        return result.affected ?? 0;
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
