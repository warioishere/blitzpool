import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GroupService, GroupServiceError } from '../../services/group.service';
import { GroupSoloService } from '../../services/group-solo.service';
import { InvitationServiceError, PplnsGroupInvitationService } from '../../services/pplns-group-invitation.service';
import { AddressEmailService } from '../../services/address-email.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { eStratumErrorCode } from '../../models/enums/eStratumErrorCode';
import { generateFormattedTimeSlots } from '../../utils/timeslot.utils';

interface CreateGroupDto {
    name?: string;
    creatorAddress?: string;
}

interface AddMemberDto {
    address?: string;
}

interface AddMembersBatchDto {
    addresses?: string[];
}

interface TransferDto {
    toAddress?: string;
}

@Controller('pplns/groups')
export class PplnsGroupController {

    constructor(
        private readonly groupService: GroupService,
        private readonly groupSoloService: GroupSoloService,
        private readonly invitationService: PplnsGroupInvitationService,
        private readonly addressEmailService: AddressEmailService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
    ) {}

    /** Sum of live hashrates across all workers of an address. Matches /api/client/:address. */
    private async addressHashrate(address: string): Promise<number> {
        const workers = await this.clientService.getByAddress(address);
        return workers.reduce((sum, w) => sum + (w.hashRate ?? 0), 0);
    }

    // ── Public endpoints ─────────────────────────────────────────

    @Get()
    async list() {
        const groups = await this.groupService.listGroups();
        return groups.map(g => this.publicGroupView(g));
    }

    @Get(':id')
    async details(@Param('id') id: string, @Headers('x-admin-token') adminToken?: string) {
        return this.detailsForGroupId(id, adminToken);
    }

    /**
     * GET /pplns/groups/by-address/:address
     * Returns the (non-dissolved) group an address is a member of, if any.
     * Unlike /api/pplns/mode/:address this intentionally returns inactive
     * groups too — so a creator of a freshly-made 1-member group can still
     * open their group dashboard before the 2nd member joins.
     */
    @Get('by-address/:address')
    async byAddress(@Param('address') address: string, @Headers('x-admin-token') adminToken?: string) {
        const entry = this.groupService.getGroupForAddress(address);
        if (!entry) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        return this.detailsForGroupId(entry.groupId, adminToken);
    }

    /**
     * Returns per-member rows including a `lastShareAt` (epoch-ms or null)
     * and, for callers that supply a valid admin token, the member's
     * verified email. The email is omitted entirely when no valid admin
     * token is present — this endpoint doubles as the public group-page
     * and the admin dashboard feed, and non-admins have no business seeing
     * other members' emails.
     */
    private async detailsForGroupId(id: string, adminToken?: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);

        let isAdmin = false;
        if (adminToken) {
            try {
                await this.groupService.requireAdminToken(id, adminToken);
                isAdmin = true;
            } catch {
                // Invalid admin token is not a hard error here — the caller
                // may legitimately be a non-admin fetching public details.
                // We just don't include emails in that case.
            }
        }

        const members = await this.groupService.listMembers(id);
        const membersWithStatus = await Promise.all(members.map(async m => {
            const hashrate = await this.addressHashrate(m.address);
            const lastShareAt = await this.groupSoloService.getMemberLastActive(id, m.address);
            const row: any = {
                address: m.address,
                role: m.role,
                joinedAt: m.joinedAt,
                hashrate,
                lastShareAt,
            };
            if (isAdmin) {
                const binding = await this.addressEmailService.getVerified(m.address);
                row.email = binding?.email ?? null;
            }
            return row;
        }));
        const totalHashrate = membersWithStatus.reduce((sum, m) => sum + m.hashrate, 0);
        return {
            ...this.publicGroupView(group),
            totalHashrate,
            members: membersWithStatus,
        };
    }

    @Get(':id/hashrate')
    async hashrate(@Param('id') id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const members = await this.groupService.listMembers(id);
        const memberRates = await Promise.all(members.map(async m => ({
            address: m.address,
            hashrate: await this.addressHashrate(m.address),
        })));
        return {
            groupId: id,
            totalHashrate: memberRates.reduce((sum, m) => sum + m.hashrate, 0),
            members: memberRates,
        };
    }

    /**
     * GET /pplns/groups/:id/chart?range=1d|3d|7d
     * Historical hashrate time-series for a payout group — drop-in compatible
     * with /api/info/chart and /api/pplns/chart. Each data point is the sum of
     * each member's per-address hashrate at that 10-minute slot. Ordered by label.
     */
    @Get(':id/chart')
    async chart(
        @Param('id') id: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d',
    ) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const validRange: '1d' | '3d' | '7d' =
            range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';

        const members = await this.groupService.listMembers(id);
        if (members.length === 0) return [];

        const perAddressSeries = await Promise.all(
            members.map(m => this.clientStatisticsService.getChartDataForAddress(m.address, validRange)),
        );
        const sumByLabel = new Map<string, number>();
        for (const series of perAddressSeries) {
            for (const point of series) {
                sumByLabel.set(point.label, (sumByLabel.get(point.label) ?? 0) + point.data);
            }
        }
        return Array.from(sumByLabel.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, data]) => ({ label, data }));
    }

    /**
     * GET /pplns/groups/:id/accepted?range=1d|3d|7d
     * Pool-side aggregate of accepted shares across all group members.
     * Same shape as /api/client/:address/accepted so the UI can plug it
     * into the existing accepted-chart rendering without transformation.
     */
    @Get(':id/accepted')
    async accepted(
        @Param('id') id: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d',
    ) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const validRange: '1d' | '3d' | '7d' =
            range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';

        const members = await this.groupService.listMembers(id);
        if (members.length === 0) return { slotData: [] };

        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const days = validRange === '7d' ? 7 : validRange === '3d' ? 3 : 1;
        const sinceTime = now - days * oneDay;

        const perMember = await Promise.all(
            members.map((m) => this.clientStatisticsService.getAcceptedEntriesSince(m.address, sinceTime)),
        );
        const slotMap = new Map<number, number>();
        for (const entries of perMember) {
            for (const entry of entries) {
                slotMap.set(entry.time, (slotMap.get(entry.time) ?? 0) + entry.shares);
            }
        }

        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => ({
            counts: { accepted: slotMap.get(t) || 0 },
        }));
        return { slotData };
    }

    /**
     * GET /pplns/groups/:id/rejected?range=1d|3d|7d
     * Aggregated rejected share counts per reason, across group members.
     */
    @Get(':id/rejected')
    async rejected(
        @Param('id') id: string,
        @Query('range') range: '1d' | '3d' | '7d' = '1d',
    ) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const validRange: '1d' | '3d' | '7d' =
            range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';

        const members = await this.groupService.listMembers(id);
        if (members.length === 0) return { slotData: [] };

        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const days = validRange === '7d' ? 7 : validRange === '3d' ? 3 : 1;
        const sinceTime = now - days * oneDay;

        const perMember = await Promise.all(
            members.map((m) => this.clientRejectedStatisticsService.getEntriesSince(m.address, sinceTime)),
        );
        const slotMap = new Map<number, Record<string, { count: number; diffMinusOne: number }>>();
        for (const entries of perMember) {
            for (const entry of entries) {
                if (!slotMap.has(entry.time)) slotMap.set(entry.time, {});
                const slot = slotMap.get(entry.time)!;
                const existing = slot[entry.reason] ?? { count: 0, diffMinusOne: 0 };
                slot[entry.reason] = {
                    count: existing.count + entry.count,
                    diffMinusOne: existing.diffMinusOne + entry.shares,
                };
            }
        }

        const allReasons = Object.keys(eStratumErrorCode).filter((k) => isNaN(Number(k)));
        const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => {
            const counts: Record<string, { count: number; diffMinusOne: number }> = {};
            for (const reason of allReasons) {
                counts[reason] = slotMap.get(t)?.[reason] ?? { count: 0, diffMinusOne: 0 };
            }
            return { counts };
        });
        return { slotData };
    }

    @Get(':id/distribution')
    async distribution(@Param('id') id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        return this.groupSoloService.getRoundStats(id);
    }

    /**
     * GET /pplns/groups/:id/best-difficulty
     * Highest single-share diff submitted in the current round across all
     * group members, plus the address that submitted it. Round-based —
     * resets on block-found together with the rest of the round state.
     */
    @Get(':id/best-difficulty')
    async bestDifficulty(@Param('id') id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        return this.groupSoloService.getRoundBestDifficulty(id);
    }

    @Get(':id/history')
    async history(@Param('id') id: string, @Query('limit') limitStr?: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const limit = Math.min(parseInt(limitStr ?? '100', 10) || 100, 500);
        return this.groupSoloService.getBlockHistory(id, limit);
    }

    // ── Admin endpoints ──────────────────────────────────────────

    @Post()
    async create(@Body() body: CreateGroupDto) {
        try {
            const result = await this.groupService.createGroup(body.name ?? '', body.creatorAddress ?? '');
            return {
                ...this.publicGroupView(result.group),
                adminToken: result.adminToken,
                members: [{ address: result.group.creatorAddress, role: 'creator' }],
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * POST /pplns/groups/:id/invitations
     * Create + send a single invitation. The address must have a verified
     * email binding (see /api/email/register + /verify) — without it the
     * call returns 400 with code 'email-not-verified'. Replaces the old
     * direct-add endpoint, which was the silent-add attack vector.
     */
    // 10 invites / minute per IP. An admin with a valid token could
    // otherwise DoS the SMTP provider or spam addresses for tribunal-style
    // harassment. Token-auth isn't a substitute for rate-limiting here.
    @Throttle(10, 60)
    @Post(':id/invitations')
    async createInvitation(
        @Param('id') id: string,
        @Body() body: AddMemberDto,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const result = await this.invitationService.createInvitation(id, body.address ?? '', token);
            return { invited: true, email: result.email, expiresAt: result.expiresAt };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * POST /pplns/groups/:id/invitations/batch
     * Create invitations for multiple addresses. Per-address failures
     * (no email, already member, already invited, etc.) land in
     * `skipped` so the admin can fix them individually. Token failures
     * still abort — they're an auth issue, not per-address.
     */
    // Tighter than single because each call can send many mails.
    @Throttle(5, 60)
    @Post(':id/invitations/batch')
    async createInvitationsBatch(
        @Param('id') id: string,
        @Body() body: AddMembersBatchDto,
        @Headers('x-admin-token') token?: string,
    ) {
        // Pre-validate the admin token once by attempting to create the
        // first invitation. If that fails on token, abort the batch. All
        // subsequent calls reuse the same token through the service.
        const addresses = (body.addresses ?? []).map(a => (a ?? '').trim()).filter(a => !!a);
        const invited: { address: string; email: string; expiresAt: Date }[] = [];
        const skipped: { address: string; reason: string }[] = [];
        const seen = new Set<string>();
        for (const addr of addresses) {
            if (seen.has(addr)) {
                skipped.push({ address: addr, reason: 'duplicate-in-batch' });
                continue;
            }
            seen.add(addr);
            try {
                const r = await this.invitationService.createInvitation(id, addr, token);
                invited.push({ address: addr, email: r.email, expiresAt: r.expiresAt });
            } catch (e) {
                if (e instanceof GroupServiceError && e.code === 'invalid-token') {
                    throw this.toHttpError(e);
                }
                if (e instanceof InvitationServiceError) {
                    skipped.push({ address: addr, reason: e.code });
                    continue;
                }
                if (e instanceof GroupServiceError) {
                    skipped.push({ address: addr, reason: e.code });
                    continue;
                }
                throw e;
            }
        }
        return { invited, skipped };
    }

    /**
     * GET /pplns/groups/:id/invitations
     * List pending invitations for the group. Admin-token-auth — used by
     * the admin dashboard to see who's been invited but hasn't responded.
     *
     * The invitation token is deliberately NOT returned. It lives only in
     * the email body — that's what makes the email a trust anchor against
     * silent-add. Returning it here would let a malicious admin accept
     * the invitation on behalf of the invitee without the invitee ever
     * seeing the mail.
     */
    @Get(':id/invitations')
    async listInvitations(
        @Param('id') id: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.groupService.requireAdminToken(id, token);
            const rows = await this.invitationService.listPendingForGroup(id);
            return rows.map(r => ({
                address: r.address,
                email: r.email,
                createdAt: r.createdAt,
                expiresAt: r.expiresAt,
                status: r.status,
            }));
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * DELETE /pplns/groups/:id/invitations/by-address/:address
     * Cancel a pending invitation before the recipient responds.
     * Admin-token-auth. Addressed by (groupId, address) instead of token
     * so the admin never needs to see the secret token.
     */
    @Delete(':id/invitations/by-address/:address')
    async cancelInvitation(
        @Param('id') id: string,
        @Param('address') address: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.invitationService.cancelInvitationByAddress(id, address, token);
            return { cancelled: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * DELETE /pplns/groups/:id/members/:address
     * Remove a non-creator member. Admin-token-auth, AND the target must
     * be inactive (no share submitted for ≥ GROUP_INACTIVITY_KICK_DAYS days).
     * There is no unauthenticated "self-leave" — if a miner wants out,
     * they repoint their miner to a different address; after the
     * inactivity window the admin can prune the stale member row.
     */
    @Delete(':id/members/:address')
    async removeMember(
        @Param('id') id: string,
        @Param('address') address: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.groupService.removeMember(id, address, token);
            return { removed: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Post(':id/transfer')
    async transfer(
        @Param('id') id: string,
        @Body() body: TransferDto,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const result = await this.groupService.transferCreator(id, body.toAddress ?? '', token);
            return {
                ...this.publicGroupView(result.group),
                adminToken: result.adminToken,
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    @Delete(':id')
    async dissolve(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
        try {
            await this.groupService.dissolveGroup(id, token);
            return { dissolved: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    private publicGroupView(group: { id: string; name: string; creatorAddress: string; active: boolean; createdAt: Date }) {
        return {
            id: group.id,
            name: group.name,
            creatorAddress: group.creatorAddress,
            active: group.active,
            createdAt: group.createdAt,
        };
    }

    private toHttpError(e: unknown): HttpException {
        if (e instanceof GroupServiceError) {
            const status = {
                'missing-token': HttpStatus.UNAUTHORIZED,
                'invalid-token': HttpStatus.UNAUTHORIZED,
                'not-found': HttpStatus.NOT_FOUND,
                'not-member': HttpStatus.NOT_FOUND,
                'invalid-name': HttpStatus.BAD_REQUEST,
                'invalid-address': HttpStatus.BAD_REQUEST,
                'name-taken': HttpStatus.CONFLICT,
                'address-in-group': HttpStatus.CONFLICT,
                'already-member': HttpStatus.CONFLICT,
                'already-creator': HttpStatus.CONFLICT,
                'member-still-active': HttpStatus.FORBIDDEN,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        if (e instanceof InvitationServiceError) {
            const status = {
                'not-found': HttpStatus.NOT_FOUND,
                'expired': HttpStatus.GONE,
                'email-not-verified': HttpStatus.FAILED_DEPENDENCY,
                'invitation-pending': HttpStatus.CONFLICT,
                'already-member': HttpStatus.CONFLICT,
                'address-in-group': HttpStatus.CONFLICT,
                'already-declined': HttpStatus.CONFLICT,
                'group-dissolved': HttpStatus.GONE,
                'invalid-address': HttpStatus.BAD_REQUEST,
                'config-missing': HttpStatus.SERVICE_UNAVAILABLE,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal-error', message: (e as Error)?.message ?? 'Internal error' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}

