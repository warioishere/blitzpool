import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { GroupService, GroupServiceError, GroupRoundResetSettings } from '../../services/group.service';
import { normalizeBtcAddress } from '../../utils/btc-address.utils';
import { GroupSoloService } from '../../services/group-solo.service';
import { computeNextResetAt } from '../../services/group-round-reset.service';
import { PplnsGroupEntity } from '../../ORM/pplns-group/pplns-group.entity';
import { InvitationServiceError, PplnsGroupInvitationService, OPEN_INVITE_TTL_PRESETS, OpenInviteTtl } from '../../services/pplns-group-invitation.service';
import { JoinRequestServiceError, PplnsGroupJoinRequestService } from '../../services/pplns-group-join-request.service';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../../utils/email-mask.utils';
import { AddressEmailService } from '../../services/address-email.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { eStratumErrorCode, STRATUM_REJECT_STALE } from '../../models/enums/eStratumErrorCode';
import { generateFormattedTimeSlots } from '../../utils/timeslot.utils';
import { isoFromEpoch } from '../../utils/epoch-iso';
import { PplnsService } from '../../services/pplns.service';
import { BitcoinRpcService } from '../../services/bitcoin-rpc.service';
import { blockSubsidySats } from '../../utils/block-subsidy.utils';

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
        private readonly configService: ConfigService,
        private readonly joinRequestService: PplnsGroupJoinRequestService,
        private readonly pplnsService: PplnsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
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

    /**
     * GET /pplns/groups/public?page=1&pageSize=50
     *
     * Public directory of opt-in groups. Sorted by total hashrate desc so
     * the most active groups surface first. Each row is enriched with
     * member count + summed live hashrate so the directory card has all
     * the data it needs without a follow-up call per group.
     *
     * Pagination is server-side because a popular pool could have many
     * public groups; the UI infinite-scrolls or paginates client-side.
     */
    @Get('public')
    async listPublic(
        @Query('page') pageStr?: string,
        @Query('pageSize') pageSizeStr?: string,
    ) {
        const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr ?? '50', 10) || 50));

        const all = await this.groupService.listGroups();
        const publicGroups = all.filter(g => g.isPublic);

        // Compute member counts + hashrates in parallel; the listing is
        // cheap-ish (filtered to public groups) so this scales fine for
        // realistic pool sizes.
        const enriched = await Promise.all(publicGroups.map(async g => {
            const members = await this.groupService.listMembers(g.id);
            const memberCount = members.length;
            const totalHashrate = (await Promise.all(members.map(m => this.addressHashrate(m.address))))
                .reduce((sum, h) => sum + h, 0);
            return {
                ...this.publicGroupView(g),
                memberCount,
                totalHashrate,
            };
        }));

        enriched.sort((a, b) => b.totalHashrate - a.totalHashrate);

        const total = enriched.length;
        const start = (page - 1) * pageSize;
        const items = enriched.slice(start, start + pageSize);
        return {
            page,
            pageSize,
            total,
            items,
        };
    }

    /**
     * GET /pplns/groups/finder-bonus-cap
     *
     * Current block subsidy in sats — the admin UI uses it as the finder-bonus
     * input ceiling + hint. `height` is the next block (current tip + 1), the
     * block the subsidy applies to. Public, no auth.
     *
     * MUST be declared before `@Get(':id')` so 'finder-bonus-cap' isn't
     * captured as a group id.
     */
    @Get('finder-bonus-cap')
    finderBonusCap() {
        const height = this.bitcoinRpcService.getBlockHeight() + 1;
        return { height, subsidySats: blockSubsidySats(height) };
    }

    /**
     * GET /pplns/groups/coinbase-capacity
     *
     * How many members fit in the fixed group-solo coinbase weight budget.
     * Engine-wide (the budget is the same for every group), so the UI subtracts
     * a group's own member count to show its remaining headroom. `maxMembers`
     * is the worst-case ceiling (pessimistic P2TR weight, fee output reserved)
     * from the same `getMaxCoinbaseOutputs()` the operator capacity-alert uses.
     * Public, no auth.
     *
     * MUST be declared before `@Get(':id')` so 'coinbase-capacity' isn't
     * captured as a group id.
     */
    @Get('coinbase-capacity')
    coinbaseCapacity() {
        const { coinbaseWeightBudget, feeAddress } = this.pplnsService.getFeeConfig();
        return {
            maxMembers: this.pplnsService.getMaxCoinbaseOutputs(),
            weightBudget: coinbaseWeightBudget,
            // Mirrors what getMaxCoinbaseOutputs() reserves: a fee output slot
            // exists iff a fee address is configured.
            hasFeeOutput: !!feeAddress,
        };
    }

    /**
     * GET /pplns/groups/join-requests/by-address/:address
     *
     * Pending join requests submitted by this address — used by the
     * directory page to show "Pending review" instead of the request
     * form on groups the user has already pinged. Public, no auth: no
     * sensitive data is exposed (just group ids the user already knows
     * they applied to).
     *
     * MUST be declared before `@Get(':id')` so 'join-requests' isn't
     * captured as a group id.
     */
    @Get('join-requests/by-address/:address')
    async listJoinRequestsForAddress(@Param('address') address: string) {
        const rows = await this.joinRequestService.listForAddress(address);
        return rows.map(r => ({ ...r, createdAt: isoFromEpoch(r.createdAt) }));
    }

    /**
     * GET /pplns/groups/public/:id
     *
     * Public detail page for a directory group. Returns a directory row
     * plus the recent block-history (capped) so the user can see if the
     * group has ever found anything. Member list is intentionally NOT
     * exposed — that's a privacy boundary; non-members shouldn't see who
     * else is mining there.
     */
    @Get('public/:id')
    async detailsPublic(@Param('id') id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt || !group.isPublic) {
            throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        }
        const members = await this.groupService.listMembers(id);
        const memberCount = members.length;
        const totalHashrate = (await Promise.all(members.map(m => this.addressHashrate(m.address))))
            .reduce((sum, h) => sum + h, 0);
        const history = await this.groupSoloService.getBlockHistory(id, 20);
        return {
            ...this.publicGroupView(group),
            memberCount,
            totalHashrate,
            recentBlocks: history.map(h => ({ ...h, createdAt: isoFromEpoch(h.createdAt) })),
        };
    }

    /**
     * POST /pplns/groups/public/:id/join-request
     * Body: { address: string, message?: string }
     *
     * User-submitted request to join a public group. Public — the trust
     * anchor is the verified email binding for the supplied address.
     * Rate-limited per-IP (preventing spam from a single source) and
     * per-address (multi-layer in service: DB unique partial index +
     * service-level pending cap + reject cooldown).
     */
    @UseGuards(ThrottlerGuard)
    @Throttle(5, 60)
    @Post('public/:id/join-request')
    async createJoinRequest(
        @Param('id') id: string,
        @Body() body: { address?: string; message?: string },
    ) {
        try {
            const r = await this.joinRequestService.createJoinRequest(id, body?.address ?? '', body?.message);
            return { id: r.id, groupId: r.groupId, status: r.status, createdAt: isoFromEpoch(r.createdAt) };
        } catch (e) {
            throw this.toHttpError(e);
        }
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
     * Returns per-member rows including a `lastAcceptedShareAt` (epoch-ms
     * or null) and, for callers that supply a valid admin token, the
     * member's verified email. The email is omitted entirely when no valid
     * admin token is present — this endpoint doubles as the public
     * group-page and the admin dashboard feed, and non-admins have no
     * business seeing other members' emails.
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
            const lastAcceptedShareAt = await this.groupSoloService.getMemberLastActive(id, m.address);
            const row: any = {
                address: m.address,
                role: m.role,
                joinedAt: isoFromEpoch(m.joinedAt),
                hashrate,
                lastAcceptedShareAt: isoFromEpoch(lastAcceptedShareAt),
            };
            if (isAdmin) {
                // Privacy: even the admin only sees a masked email so a
                // leaked admin token can't be used to build a BTC↔email
                // mapping for members. The mask still lets the admin
                // distinguish "verified email present" from "no email"
                // (null → no binding, masked string → bound + verified).
                const binding = await this.addressEmailService.getVerified(m.address);
                row.email = binding ? maskEmail(binding.email) : null;
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

        // See app.controller `infoRejected` for rationale — Stale is
        // tracked alongside the wire-level rejection codes.
        const allReasons = [
            ...Object.keys(eStratumErrorCode).filter((k) => isNaN(Number(k))),
            STRATUM_REJECT_STALE,
        ];
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
        const r = await this.groupSoloService.getRoundBestDifficulty(id);
        return { ...r, time: isoFromEpoch(r.time) };
    }

    @Get(':id/history')
    async history(@Param('id') id: string, @Query('limit') limitStr?: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const limit = Math.min(parseInt(limitStr ?? '100', 10) || 100, 500);
        const rows = await this.groupSoloService.getBlockHistory(id, limit);
        return rows.map(r => ({ ...r, createdAt: isoFromEpoch(r.createdAt) }));
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
    @UseGuards(ThrottlerGuard)
    @Throttle(10, 60)
    @Post(':id/invitations')
    async createInvitation(
        @Param('id') id: string,
        @Body() body: AddMemberDto,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const result = await this.invitationService.createInvitation(id, body.address ?? '', token);
            // Privacy: return the masked email so the success toast confirms
            // "invite went out" without revealing the BTC↔email mapping.
            return { invited: true, email: maskEmail(result.email), expiresAt: isoFromEpoch(result.expiresAt) };
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
    @UseGuards(ThrottlerGuard)
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
        //
        // Dedup BEFORE normalisation would let ['BC1Q...', 'bc1q...']
        // through as two distinct entries — both then collapse onto the
        // same row inside createInvitation, masking the duplicate.
        const addresses = (body.addresses ?? []).map(a => (a ?? '').trim()).filter(a => !!a);
        const invited: { address: string; email: string; expiresAt: string | null }[] = [];
        const skipped: { address: string; reason: string }[] = [];
        const seen = new Set<string>();
        for (const addr of addresses) {
            const dedupKey = normalizeBtcAddress(addr) || addr;
            if (seen.has(dedupKey)) {
                skipped.push({ address: addr, reason: 'duplicate-in-batch' });
                continue;
            }
            seen.add(dedupKey);
            try {
                const r = await this.invitationService.createInvitation(id, addr, token);
                invited.push({ address: addr, email: maskEmail(r.email), expiresAt: isoFromEpoch(r.expiresAt) });
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
                // Privacy: masked even for the admin — see detailsForGroupId.
                email: r.email ? maskEmail(r.email) : null,
                createdAt: isoFromEpoch(r.createdAt),
                expiresAt: isoFromEpoch(r.expiresAt),
                status: r.status,
            }));
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * POST /pplns/groups/:id/invitations/open
     * Generate (or replace) the active open-invite link for the group.
     * Body: { ttl: '1h' | '24h' | '7d' | '30d' }
     * Response: { token, expiresAt, link } where link is the public URL
     * the admin can share. Atomic-replaces any existing active open link.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle(10, 60)
    @Post(':id/invitations/open')
    async createOpenInvitation(
        @Param('id') id: string,
        @Body() body: { ttl?: string; approvalRequired?: boolean },
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const ttl = body?.ttl as OpenInviteTtl;
            const approvalRequired = body?.approvalRequired === true;
            const result = await this.invitationService.createOpenInvite(id, ttl, token, approvalRequired);
            const baseUrl = (this.configService.get<string>('POOL_BASE_URL') ?? '').replace(/\/+$/, '');
            const link = baseUrl ? `${baseUrl}/#/invite/open/${result.token}` : `/#/invite/open/${result.token}`;
            return {
                token: result.token,
                expiresAt: isoFromEpoch(result.expiresAt),
                approvalRequired: result.approvalRequired,
                link,
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * GET /pplns/groups/:id/invitations/open/active
     * Returns the currently active open-invite link (or null). Admin-token
     * gated — the token is the live secret, never exposed publicly.
     */
    @Get(':id/invitations/open/active')
    async getActiveOpenInvitation(
        @Param('id') id: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const result = await this.invitationService.getActiveOpenInvite(id, token);
            if (!result) return { active: false };
            const baseUrl = (this.configService.get<string>('POOL_BASE_URL') ?? '').replace(/\/+$/, '');
            const link = baseUrl ? `${baseUrl}/#/invite/open/${result.token}` : `/#/invite/open/${result.token}`;
            return {
                active: true,
                token: result.token,
                expiresAt: isoFromEpoch(result.expiresAt),
                createdAt: isoFromEpoch(result.createdAt),
                approvalRequired: result.approvalRequired,
                link,
            };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * DELETE /pplns/groups/:id/invitations/open
     * Manually revoke the active open-invite link. Idempotent.
     */
    @Delete(':id/invitations/open')
    async revokeOpenInvitation(
        @Param('id') id: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.invitationService.revokeOpenInvite(id, token);
            return { revoked: true };
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
     * GET /pplns/groups/:id/join-requests?includeDecided=1
     * List user-initiated join requests. Admin-token gated. Default returns
     * only pending; pass `includeDecided=1` to also see recent approvals
     * and rejections (useful for audit / undo-ish flows).
     */
    @Get(':id/join-requests')
    async listJoinRequests(
        @Param('id') id: string,
        @Query('includeDecided') includeDecided?: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const rows = await this.joinRequestService.listForGroup(id, token, {
                includeDecided: includeDecided === '1' || includeDecided === 'true',
            });
            return rows.map(r => ({
                id: r.id,
                address: r.address,
                // Privacy: masked even for the admin — see detailsForGroupId.
                email: maskEmail(r.email),
                message: r.message,
                status: r.status,
                createdAt: isoFromEpoch(r.createdAt),
                decidedAt: isoFromEpoch(r.decidedAt),
            }));
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * POST /pplns/groups/:id/join-requests/:reqId/approve
     * Approve a pending join request — adds the address as a member and
     * notifies them by email. Admin-token gated.
     */
    @Post(':id/join-requests/:reqId/approve')
    async approveJoinRequest(
        @Param('id') id: string,
        @Param('reqId') reqId: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.joinRequestService.approveRequest(id, reqId, token);
            return { approved: true };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

    /**
     * POST /pplns/groups/:id/join-requests/:reqId/reject
     * Reject a pending join request and notify the requester by email.
     * Admin-token gated.
     */
    @Post(':id/join-requests/:reqId/reject')
    async rejectJoinRequest(
        @Param('id') id: string,
        @Param('reqId') reqId: string,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            await this.joinRequestService.rejectRequest(id, reqId, token);
            return { rejected: true };
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

    /**
     * PATCH /pplns/groups/:id/settings
     * Admin-only update of the round-reset config — interval, fire-hour,
     * timezone, finder bonus. PATCH semantics:
     *   - omit a field   → leave column untouched
     *   - field = null   → clear the column (interval=null disables the
     *                      schedule; finderBonusSats=null becomes 0)
     *   - field = value  → set the column
     *
     * After persistence, the per-group cron job is re-armed (or unscheduled
     * if interval was cleared) via GroupRoundResetService.applyConfig.
     */
    @Patch(':id/settings')
    async updateSettings(
        @Param('id') id: string,
        @Body() body: GroupRoundResetSettings,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const updated = await this.groupService.updateRoundResetConfig(id, body ?? {}, token);
            // Round-trip the settings the admin should see — bigint-safe via
            // .toString() so JSON serialisation doesn't choke.
            return {
                id: updated.id,
                roundResetPreset: updated.roundResetPreset ?? null,
                roundResetIntervalDays: updated.roundResetIntervalDays,
                roundResetTimezone: updated.roundResetTimezone,
                finderBonusSats: updated.finderBonusSats ?? 0,
                lastRoundResetAt: isoFromEpoch(updated.lastRoundResetAt),
                nextResetAt: computeNextResetAt(updated as PplnsGroupEntity)?.toISOString() ?? null,
                isPublic: updated.isPublic ?? false,
                maxMembers: updated.maxMembers ?? null,
                resetRoundOnBlock: updated.resetRoundOnBlock ?? false,
            };
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

    private publicGroupView(group: {
        id: string; name: string; creatorAddress: string; active: boolean; createdAt: number;
        roundResetPreset?: 'daily' | 'weekly' | 'monthly' | 'custom' | null;
        roundResetIntervalDays?: number | null;
        roundResetHourLocal?: number | null;
        roundResetTimezone?: string | null;
        finderBonusSats?: number | null;
        lastRoundResetAt?: number | null;
        dissolvedAt?: number | null;
        isPublic?: boolean;
        maxMembers?: number | null;
        resetRoundOnBlock?: boolean;
    }) {
        // Round-reset config + finder bonus are intentionally exposed on the
        // public view — every member needs them to render the "next reset in
        // Xd Yh Zm" countdown and finder-bonus badge in their dashboard.
        // `nextResetAt` is computed server-side so the UI doesn't have to do
        // calendar / timezone math; it just shows a live countdown.
        return {
            id: group.id,
            name: group.name,
            creatorAddress: group.creatorAddress,
            active: group.active,
            createdAt: isoFromEpoch(group.createdAt),
            roundResetPreset: group.roundResetPreset ?? null,
            roundResetIntervalDays: group.roundResetIntervalDays ?? null,
            roundResetTimezone: group.roundResetTimezone ?? null,
            finderBonusSats: group.finderBonusSats ?? 0,
            lastRoundResetAt: isoFromEpoch(group.lastRoundResetAt),
            nextResetAt: computeNextResetAt(group as PplnsGroupEntity)?.toISOString() ?? null,
            isPublic: group.isPublic ?? false,
            maxMembers: group.maxMembers ?? null,
            resetRoundOnBlock: group.resetRoundOnBlock ?? false,
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
                'invalid-interval': HttpStatus.BAD_REQUEST,
                'invalid-hour': HttpStatus.BAD_REQUEST,
                'invalid-timezone': HttpStatus.BAD_REQUEST,
                'invalid-bonus': HttpStatus.BAD_REQUEST,
                'invalid-max-members': HttpStatus.BAD_REQUEST,
                'incomplete-schedule': HttpStatus.BAD_REQUEST,
                'name-taken': HttpStatus.CONFLICT,
                'address-in-group': HttpStatus.CONFLICT,
                'already-member': HttpStatus.CONFLICT,
                'already-creator': HttpStatus.CONFLICT,
                'group-full': HttpStatus.CONFLICT,
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
        if (e instanceof JoinRequestServiceError) {
            const status = {
                'not-found': HttpStatus.NOT_FOUND,
                'invalid-address': HttpStatus.BAD_REQUEST,
                'email-not-verified': HttpStatus.FAILED_DEPENDENCY,
                'already-member': HttpStatus.CONFLICT,
                'address-in-group': HttpStatus.CONFLICT,
                'request-pending': HttpStatus.CONFLICT,
                'too-many-pending': HttpStatus.TOO_MANY_REQUESTS,
                'reject-cooldown': HttpStatus.TOO_MANY_REQUESTS,
                'group-dissolved': HttpStatus.GONE,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal-error', message: (e as Error)?.message ?? 'Internal error' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}

