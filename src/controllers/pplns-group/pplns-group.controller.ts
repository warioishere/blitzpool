import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { GroupService, GroupServiceError } from '../../services/group.service';
import { GroupSoloService } from '../../services/group-solo.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';

interface CreateGroupDto {
    name?: string;
    creatorAddress?: string;
}

interface AddMemberDto {
    address?: string;
}

interface TransferDto {
    toAddress?: string;
}

@Controller('pplns/groups')
export class PplnsGroupController {

    constructor(
        private readonly groupService: GroupService,
        private readonly groupSoloService: GroupSoloService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
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
    async details(@Param('id') id: string) {
        return this.detailsForGroupId(id);
    }

    /**
     * GET /pplns/groups/by-address/:address
     * Returns the (non-dissolved) group an address is a member of, if any.
     * Unlike /api/pplns/mode/:address this intentionally returns inactive
     * groups too — so a creator of a freshly-made 1-member group can still
     * open their group dashboard before the 2nd member joins.
     */
    @Get('by-address/:address')
    async byAddress(@Param('address') address: string) {
        const entry = this.groupService.getGroupForAddress(address);
        if (!entry) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        return this.detailsForGroupId(entry.groupId);
    }

    private async detailsForGroupId(id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        const members = await this.groupService.listMembers(id);
        const membersWithHashrate = await Promise.all(members.map(async m => ({
            address: m.address,
            role: m.role,
            joinedAt: m.joinedAt,
            hashrate: await this.addressHashrate(m.address),
        })));
        const totalHashrate = membersWithHashrate.reduce((sum, m) => sum + m.hashrate, 0);
        return {
            ...this.publicGroupView(group),
            totalHashrate,
            members: membersWithHashrate,
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

    @Get(':id/distribution')
    async distribution(@Param('id') id: string) {
        const group = await this.groupService.getGroup(id);
        if (!group || group.dissolvedAt) throw new HttpException({ code: 'not-found' }, HttpStatus.NOT_FOUND);
        return this.groupSoloService.getRoundStats(id);
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

    @Post(':id/members')
    async addMember(
        @Param('id') id: string,
        @Body() body: AddMemberDto,
        @Headers('x-admin-token') token?: string,
    ) {
        try {
            const member = await this.groupService.addMember(id, body.address ?? '', token);
            return { address: member.address, role: member.role, joinedAt: member.joinedAt };
        } catch (e) {
            throw this.toHttpError(e);
        }
    }

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

    @Delete(':id/members/:address/self')
    async selfLeave(@Param('id') id: string, @Param('address') address: string) {
        try {
            await this.groupService.selfLeave(id, address);
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
                'creator-cannot-self-leave': HttpStatus.FORBIDDEN,
            }[e.code] ?? HttpStatus.BAD_REQUEST;
            return new HttpException({ code: e.code, message: e.message }, status);
        }
        return new HttpException({ code: 'internal-error', message: (e as Error)?.message ?? 'Internal error' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
