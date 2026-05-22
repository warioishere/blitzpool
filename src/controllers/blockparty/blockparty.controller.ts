import {
    Body, Controller, Delete, Get, Headers, HttpException, HttpStatus,
    Param, Patch, Post, Query,
} from '@nestjs/common';

import { BlockpartyService, BlockpartyServiceError } from '../../services/blockparty.service';
import {
    BlockpartyInvitationService,
    InvitationServiceError,
} from '../../services/blockparty-invitation.service';
import { normalizeBtcAddress } from '../../utils/btc-address.utils';
import { maskEmail } from '../../utils/email-mask.utils';

interface CreateBlockpartyDto {
    name?: string;
    adminAddress?: string;
    adminEmail?: string;
    adminPercentBp?: number;
}

interface AddMemberDto {
    address?: string;
    email?: string;
    percentBp?: number;
    ttlDays?: number;
}

interface UpdateSplitsDto {
    splits?: Array<{ address: string; percentBp: number }>;
}

interface BatchMembersDto {
    members?: Array<{ address: string; percentBp: number; email?: string }>;
    ttlDays?: number;
}

interface UpdateRentalHintDto {
    hint?: string | null;
}

const ADMIN_TOKEN_HEADER = 'x-blockparty-admin-token';
const MEMBER_TOKEN_HEADER = 'x-blockparty-member-token';

@Controller('blockparty')
export class BlockpartyController {

    constructor(
        private readonly blockpartyService: BlockpartyService,
        private readonly invitationService: BlockpartyInvitationService,
    ) {}

    // ── Discovery ───────────────────────────────────────────────

    @Get()
    async list() {
        const groups = await this.blockpartyService.listGroups();
        return groups.map(g => this.publicView(g));
    }

    @Get('public')
    async listPublic() {
        // For v1 every non-dissolved party is publicly discoverable —
        // there's no isPublic flag (parties are short-lived rental
        // arrangements, not long-lived clubs). Sort by createdAt desc.
        const all = await this.blockpartyService.listGroups();
        return all.filter(g => g.status !== 'dissolved').map(g => this.publicView(g));
    }

    @Get('by-address/:address')
    async getByAddress(@Param('address') address: string) {
        const normalized = normalizeBtcAddress(address);
        if (!normalized) {
            throw new HttpException({ code: 'invalid-address' }, HttpStatus.BAD_REQUEST);
        }
        const groupId = this.blockpartyService.getGroupIdForAddress(normalized);
        if (!groupId) {
            return { groupId: null };
        }
        const group = await this.blockpartyService.getGroup(groupId);
        if (!group) {
            return { groupId: null };
        }
        // Admin role gets surfaced so the UI can pick the right route
        // (admin dashboard vs. read-only detail).
        const members = await this.blockpartyService.listMembers(groupId);
        const me = members.find(m => m.address === normalized);
        return {
            groupId,
            groupName: group.name,
            status: group.status,
            role: me?.role ?? null,
        };
    }

    @Get(':id')
    async getDetail(@Param('id') groupId: string) {
        const group = await this.blockpartyService.getGroup(groupId);
        if (!group) {
            throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        }
        const members = await this.blockpartyService.listMembers(groupId);
        return {
            ...this.publicView(group),
            members: members.map(m => ({
                address: m.address,
                email: maskEmail(m.email),
                percentBp: m.percentBp,
                role: m.role,
                confirmed: m.confirmedAt != null,
            })),
        };
    }

    @Get(':id/history')
    async getHistory(@Param('id') groupId: string) {
        const group = await this.blockpartyService.getGroup(groupId);
        if (!group) {
            throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        }
        const rows = await this.blockpartyService.getHistory(groupId);
        return rows.map(r => ({
            blockHeight: r.blockHeight,
            blockHash: r.blockHash,
            foundAt: r.foundAt,
            coinbaseValueSats: r.coinbaseValueSats,
            poolFeeSats: r.poolFeeSats,
            splits: r.splits,
        }));
    }

    // ── Admin lifecycle ──────────────────────────────────────────

    @Post()
    async create(@Body() body: CreateBlockpartyDto) {
        try {
            const { group, adminToken } = await this.blockpartyService.createGroup({
                name: body.name ?? '',
                adminAddress: body.adminAddress ?? '',
                adminEmail: body.adminEmail ?? '',
                adminPercentBp: body.adminPercentBp ?? 0,
            });
            return {
                group: this.publicView(group),
                adminToken, // one-shot — admin must store this client-side
                poolFeePercent: this.blockpartyService.getPoolFeePercent(),
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/members')
    async addMember(
        @Param('id') groupId: string,
        @Body() body: AddMemberDto,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            const member = await this.blockpartyService.addMember(groupId, {
                address: body.address ?? '',
                percentBp: body.percentBp ?? 0,
                // Only pass email through if the caller explicitly supplied
                // one — otherwise let the service resolve it from the
                // verified binding (mirror of the Group-Solo invite flow).
                ...(body.email ? { email: body.email } : {}),
            }, token);
            const { token: inviteToken } = await this.invitationService.createInvitation({
                groupId,
                address: member.address,
                email: member.email,
                ttlDays: body.ttlDays,
            });
            return {
                member: {
                    address: member.address,
                    email: maskEmail(member.email),
                    percentBp: member.percentBp,
                    role: member.role,
                    confirmed: false,
                },
                inviteToken, // one-shot — admin shares this with the member out-of-band
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Delete(':id/members/:address')
    async removeMember(
        @Param('id') groupId: string,
        @Param('address') address: string,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            await this.blockpartyService.removeMember(groupId, address, token);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Patch(':id/splits')
    async updateSplits(
        @Param('id') groupId: string,
        @Body() body: UpdateSplitsDto,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            await this.blockpartyService.updateSplits(groupId, body.splits ?? [], token);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/members/:address/resend-invitation')
    async resendInvitation(
        @Param('id') groupId: string,
        @Param('address') address: string,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            await this.blockpartyService.requireAdminToken(groupId, token);
            const { resent } = await this.invitationService.resendInvitation(groupId, address);
            return { ok: true, resent };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/transition-confirming')
    async transitionToConfirming(
        @Param('id') groupId: string,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            await this.blockpartyService.transitionToConfirming(groupId, token);
            const group = await this.blockpartyService.getGroup(groupId);
            return { status: group?.status };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/dissolve')
    async dissolve(
        @Param('id') groupId: string,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            await this.blockpartyService.dissolveGroup(groupId, token);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Get(':id/invitations')
    async listInvitations(
        @Param('id') groupId: string,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            // Admin-token-gated. Don't return the raw token in the list —
            // that would let anyone with admin access claim invites on
            // behalf of pending members. Admin can re-issue if a token
            // is genuinely lost.
            await this.blockpartyService.requireAdminToken(groupId, token);
            const invitations = await this.invitationService.listForGroup(groupId);
            // Token IS exposed here — this endpoint is admin-token-gated, and
            // the admin needs the raw token to call /invitations/:token for
            // revoke. Anyone with the admin token can already mint a fresh
            // invitation, so exposing existing pending ones is no extra risk.
            return invitations.map(i => ({
                token: i.token,
                address: i.address,
                email: maskEmail(i.email),
                status: i.status,
                createdAt: i.createdAt,
                expiresAt: i.expiresAt,
                respondedAt: i.respondedAt,
            }));
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    // ── Invitation (recipient side) ──────────────────────────────

    @Get('invite/:token')
    async getInvitation(@Param('token') token: string) {
        const view = await this.invitationService.getInvitationView(token);
        if (!view) {
            throw new HttpException({ code: 'invitation-not-found' }, HttpStatus.NOT_FOUND);
        }
        return view;
    }

    @Post('invite/:token/accept')
    async acceptInvitation(@Param('token') token: string) {
        try {
            const { memberToken } = await this.invitationService.accept(token);
            // memberToken is one-shot — surfaces in the response exactly
            // here. Member must persist it (localStorage); needed for
            // re-confirmations after admin %-edits and for member-view
            // read access.
            return { ok: true, memberToken };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/members/:address/reconfirm')
    async reconfirmMember(
        @Param('id') groupId: string,
        @Param('address') address: string,
        @Headers(MEMBER_TOKEN_HEADER) memberToken: string | undefined,
    ) {
        try {
            await this.blockpartyService.confirmAsMember(groupId, address, memberToken);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Get(':id/member-view/:address')
    async memberView(
        @Param('id') groupId: string,
        @Param('address') address: string,
        @Headers(MEMBER_TOKEN_HEADER) memberToken: string | undefined,
    ) {
        try {
            // Token gates this read so members get full splits + emails
            // visible to them, the public detail endpoint stays masked.
            await this.blockpartyService.requireMemberToken(groupId, address, memberToken);
            const group = await this.blockpartyService.getGroup(groupId);
            if (!group) {
                throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
            }
            const members = await this.blockpartyService.listMembers(groupId);
            return {
                ...this.publicView(group),
                rentalProviderHint: group.rentalProviderHint,
                members: members.map(m => ({
                    address: m.address,
                    // Members see masked emails of OTHER members but their own un-masked
                    // so they can verify the binding.
                    email: m.address === address ? m.email : maskEmail(m.email),
                    percentBp: m.percentBp,
                    role: m.role,
                    confirmed: m.confirmedAt != null,
                })),
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/members/batch')
    async addMembersBatch(
        @Param('id') groupId: string,
        @Body() body: BatchMembersDto,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            const inputs = body.members ?? [];
            if (inputs.length === 0) {
                throw new HttpException({ code: 'no-members' }, HttpStatus.BAD_REQUEST);
            }
            // Process one-by-one so a single bad input returns a structured
            // partial result rather than rolling back valid invites. Mirrors
            // PPLNS /invitations/batch.
            const results: Array<{ address: string; ok: true; inviteToken: string } | { address: string; ok: false; code: string; message: string }> = [];
            for (const input of inputs) {
                try {
                    const member = await this.blockpartyService.addMember(groupId, {
                        address: input.address ?? '',
                        percentBp: input.percentBp ?? 0,
                        ...(input.email ? { email: input.email } : {}),
                    }, token);
                    const { token: inviteToken } = await this.invitationService.createInvitation({
                        groupId,
                        address: member.address,
                        email: member.email,
                        ttlDays: body.ttlDays,
                    });
                    results.push({ address: member.address, ok: true, inviteToken });
                } catch (e) {
                    const code = (e as BlockpartyServiceError)?.code ?? 'unknown';
                    const message = (e as Error)?.message ?? 'error';
                    results.push({ address: input.address ?? '', ok: false, code, message });
                }
            }
            return { results };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Patch(':id/rental-hint')
    async updateRentalHint(
        @Param('id') groupId: string,
        @Body() body: UpdateRentalHintDto,
        @Headers(ADMIN_TOKEN_HEADER) token: string | undefined,
    ) {
        try {
            const group = await this.blockpartyService.updateRentalProviderHint(groupId, body.hint ?? null, token);
            return { rentalProviderHint: group.rentalProviderHint };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post('invite/:token/decline')
    async declineInvitation(@Param('token') token: string) {
        try {
            await this.invitationService.decline(token);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Delete(':id/invitations/:token')
    async revokeInvitation(
        @Param('id') groupId: string,
        @Param('token') token: string,
        @Headers(ADMIN_TOKEN_HEADER) adminToken: string | undefined,
    ) {
        try {
            await this.blockpartyService.requireAdminToken(groupId, adminToken);
            await this.invitationService.revoke(groupId, token);
            return { ok: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    private publicView(group: { id: string; name: string; adminAddress: string; status: string; lastShareAt: number | null; createdAt: number; dissolvedAt: number | null; rentalProviderHint?: string | null }) {
        return {
            id: group.id,
            name: group.name,
            adminAddress: group.adminAddress,
            status: group.status,
            lastShareAt: group.lastShareAt,
            createdAt: group.createdAt,
            dissolvedAt: group.dissolvedAt,
            rentalProviderHint: group.rentalProviderHint ?? null,
        };
    }

    private toHttpError(e: unknown): HttpException {
        if (e instanceof HttpException) return e;
        if (e instanceof BlockpartyServiceError) {
            const status = {
                'missing-token': HttpStatus.UNAUTHORIZED,
                'invalid-token': HttpStatus.UNAUTHORIZED,
                'missing-member-token': HttpStatus.UNAUTHORIZED,
                'invalid-member-token': HttpStatus.UNAUTHORIZED,
                'member-not-confirmed': HttpStatus.FORBIDDEN,
                'not-found': HttpStatus.NOT_FOUND,
                'not-member': HttpStatus.NOT_FOUND,
                'invalid-name': HttpStatus.BAD_REQUEST,
                'invalid-address': HttpStatus.BAD_REQUEST,
                'invalid-email': HttpStatus.BAD_REQUEST,
                'invalid-percent': HttpStatus.BAD_REQUEST,
                'invalid-splits-sum': HttpStatus.BAD_REQUEST,
                'invalid-state': HttpStatus.CONFLICT,
                'name-taken': HttpStatus.CONFLICT,
                'admin-address-taken': HttpStatus.CONFLICT,
                'address-in-blockparty': HttpStatus.CONFLICT,
                'address-in-pplns-group': HttpStatus.CONFLICT,
                'email-not-verified': HttpStatus.FAILED_DEPENDENCY,
                'admin-cannot-rejoin': HttpStatus.CONFLICT,
                'admin-cannot-be-removed': HttpStatus.CONFLICT,
                'not-editable': HttpStatus.CONFLICT,
                'no-members': HttpStatus.BAD_REQUEST,
                'dissolve-cooldown': HttpStatus.FORBIDDEN,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        if (e instanceof InvitationServiceError) {
            const status = {
                'invitation-not-found': HttpStatus.NOT_FOUND,
                'invitation-not-pending': HttpStatus.CONFLICT,
                'invitation-pending': HttpStatus.CONFLICT,
                'invalid-address': HttpStatus.BAD_REQUEST,
                'not-found': HttpStatus.NOT_FOUND,
                'not-editable': HttpStatus.CONFLICT,
                'not-member': HttpStatus.NOT_FOUND,
                // Operational misconfiguration (POOL_BASE_URL unset) —
                // honest 500 so monitoring + UI surface it as a server
                // problem, not a user input issue.
                'config-missing': HttpStatus.INTERNAL_SERVER_ERROR,
                // SMTP-layer failure — temporary, transient. Surfacing
                // as 502 lets the UI distinguish "your input is fine,
                // the email gateway is sad" from generic 500s.
                'email-send-failed': HttpStatus.BAD_GATEWAY,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException(
            { code: 'internal-error', message: (e as Error)?.message ?? 'Internal error' },
            HttpStatus.INTERNAL_SERVER_ERROR,
        );
    }
}
