import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InvitationServiceError, PplnsGroupInvitationService } from '../../services/pplns-group-invitation.service';
import { isoFromEpoch } from '../../utils/epoch-iso';

@Controller('pplns/invitations')
export class PplnsInvitationController {

    constructor(private readonly invitationService: PplnsGroupInvitationService) {}

    /**
     * GET /api/pplns/invitations/by-address/:address
     * Pending invitations for a mining address. Drives the dashboard
     * banner so the user can see they've been invited even if the email
     * went to spam.
     */
    @Get('by-address/:address')
    async listForAddress(@Param('address') address: string) {
        return this.invitationService.listPendingForAddress(address);
    }

    /**
     * GET /api/pplns/invitations/:token
     * Invitation details — group name, inviter, expiry — used by the
     * accept/decline page to render context before the user commits.
     */
    @Get(':token')
    async byToken(@Param('token') token: string) {
        const result = await this.invitationService.getByToken(token);
        if (!result) {
            throw new HttpException({ code: 'not-found', message: 'Invitation not found' }, HttpStatus.NOT_FOUND);
        }
        return {
            token: result.invitation.token,
            groupId: result.group.id,
            groupName: result.group.name,
            inviterAddress: result.group.creatorAddress,
            address: result.invitation.address,
            email: result.invitation.email,
            status: result.invitation.status,
            createdAt: isoFromEpoch(result.invitation.createdAt),
            expiresAt: isoFromEpoch(result.invitation.expiresAt),
            respondedAt: isoFromEpoch(result.invitation.respondedAt),
        };
    }

    /**
     * POST /api/pplns/invitations/:token/accept
     * Accept the invitation — creates the membership. Token is the only
     * auth: knowing it implies access to the email account that received
     * the invitation.
     */
    // 20 req/min per IP. Token is 256-bit so brute force isn't the concern;
    // this just caps accidental burst / malicious retry loops.
    @UseGuards(ThrottlerGuard)
    @Throttle(20, 60)
    @Post(':token/accept')
    async accept(@Param('token') token: string) {
        try {
            const member = await this.invitationService.accept(token);
            return { address: member.address, role: member.role, joinedAt: isoFromEpoch(member.joinedAt), groupId: member.groupId };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    /**
     * POST /api/pplns/invitations/:token/decline
     * Decline (or revoke pending state). No auth — there's no incentive
     * to decline on someone's behalf, and it lets the recipient dispose
     * of an unwanted invitation even without email access.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle(20, 60)
    @Post(':token/decline')
    async decline(@Param('token') token: string) {
        try {
            await this.invitationService.decline(token);
            return { ok: true };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    /**
     * GET /api/pplns/invitations/open/:token
     * Public landing-page lookup for an open invite. Returns just enough
     * to render the join form: group name + expiry. No member list, no
     * admin secrets. 404 if the token is unknown, expired, revoked, or
     * for a dissolved group.
     */
    @Get('open/:token')
    async openInviteByToken(@Param('token') token: string) {
        const result = await this.invitationService.getOpenInvitePublic(token);
        if (!result) {
            throw new HttpException({ code: 'not-found', message: 'Open invitation not found or no longer valid' }, HttpStatus.NOT_FOUND);
        }
        return {
            token: result.token,
            groupId: result.groupId,
            groupName: result.groupName,
            expiresAt: isoFromEpoch(result.expiresAt),
            approvalRequired: result.approvalRequired,
        };
    }

    /**
     * POST /api/pplns/invitations/open/:token/accept
     * Accept an open invite by binding it to a specific address. The
     * address must have a verified email binding (same trust anchor as
     * directed invites). Multi-use: the link stays valid until TTL.
     */
    // 10 req/min per IP. Open links can be claimed by anyone, so this is
    // the realistic abuse vector — limit harder than the directed flow.
    @UseGuards(ThrottlerGuard)
    @Throttle(10, 60)
    @Post('open/:token/accept')
    async acceptOpen(
        @Param('token') token: string,
        @Body() body: { address?: string },
    ) {
        try {
            const member = await this.invitationService.acceptOpenInvite(token, body?.address ?? '');
            return { address: member.address, role: member.role, joinedAt: isoFromEpoch(member.joinedAt), groupId: member.groupId };
        } catch (e) {
            throw this.toHttp(e);
        }
    }

    private toHttp(e: any): HttpException {
        if (e instanceof InvitationServiceError) {
            const status = e.code === 'not-found' ? HttpStatus.NOT_FOUND
                : e.code === 'expired' || e.code === 'group-dissolved' ? HttpStatus.GONE
                : e.code === 'already-declined' || e.code === 'already-member' ? HttpStatus.CONFLICT
                // 403 for approval-required: the link is valid, but this
                // path is not how to redeem it — frontend must redirect to
                // the join-request flow.
                : e.code === 'approval-required' ? HttpStatus.FORBIDDEN
                : HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal', message: e?.message ?? 'unknown' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
