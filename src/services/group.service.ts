import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { PplnsGroupMemberEntity } from '../ORM/pplns-group/pplns-group-member.entity';
import { GroupSoloService } from './group-solo.service';
import { GroupRoundResetService } from './group-round-reset.service';
import { BlockpartyService } from './blockparty.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';

/**
 * Manages group lifecycle (create/transfer/dissolve), membership (add/kick/self-leave),
 * admin-token auth, and an in-memory address→groupId cache used by the stratum layer.
 *
 * Groups are "active" once they have ≥ MIN_MEMBERS_ACTIVE members; the stratum layer
 * refuses connections for addresses that belong to an inactive group.
 */

const MIN_MEMBERS_ACTIVE = 2;
const DEFAULT_KICK_INACTIVITY_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RESET_INTERVAL_DAYS = 365;
// Hard cap for finder bonus — guards against finger-fat configs that would
// strand more sats than a normal block reward (~3.125 BTC at current era).
// 1 BTC is already absurd for a per-block bonus on top of proportional split.
const MAX_FINDER_BONUS_SATS = 100_000_000;

function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export class GroupServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

export interface GroupCreateResult {
    group: PplnsGroupEntity;
    /** Plain-text admin token — shown to the creator exactly once. */
    adminToken: string;
}

export interface GroupCacheEntry {
    groupId: string;
    active: boolean;
}

/**
 * Partial-update DTO for the round-reset configuration.
 *
 * Semantics — distinguishing "absent", "null", and "value":
 *   - field undefined  → don't touch this column
 *   - field null       → clear the column (interval=null disables the schedule;
 *                        finderBonusSats=null is treated as 0)
 *   - field value      → set the column
 *
 * `finderBonusSats` accepts a JSON-friendly type (string|number|bigint) since
 * raw JSON has no bigint literal.
 */
export interface GroupRoundResetSettings {
    /**
     * Reset cadence preset. Set to a string to enable the schedule;
     * pass `null` to disable scheduled resets entirely.
     *
     *   'daily'   → every day at 00:00 in admin's TZ
     *   'weekly'  → every Monday at 00:00 in admin's TZ
     *   'monthly' → 1st of every month at 00:00 in admin's TZ
     *   'custom'  → requires `intervalDays`; fires every N days at 00:00 in TZ
     *   null      → schedule off
     */
    preset?: 'daily' | 'weekly' | 'monthly' | 'custom' | null;
    /** Only authoritative when preset === 'custom'. Integer 1..365. */
    intervalDays?: number | null;
    /** Admin's IANA timezone (browser-supplied). Required for any preset. */
    timezone?: string;
    finderBonusSats?: string | number | null;
    /**
     * Toggle public visibility. When true, the group surfaces in the
     * public directory and accepts join-requests. Omit to leave unchanged.
     */
    isPublic?: boolean;
    /**
     * Hard member cap. Positive integer to set, `null` to clear (no limit),
     * omit to leave unchanged. Enforced across all add-member paths.
     */
    maxMembers?: number | null;
    /**
     * When true, the Group-Solo round is wiped on every block-found. When
     * false (default), shares accumulate across blocks until a calendar
     * preset / manual reset fires. Omit to leave unchanged.
     */
    resetRoundOnBlock?: boolean;
}

export type RoundResetPreset = 'daily' | 'weekly' | 'monthly' | 'custom';

@Injectable()
export class GroupService implements OnModuleInit {

    /** address → { groupId, active }. Refreshed on every membership change. */
    private addressCache = new Map<string, GroupCacheEntry>();
    private readonly kickInactivityDays: number;

    constructor(
        @InjectRepository(PplnsGroupEntity)
        private readonly groupRepo: Repository<PplnsGroupEntity>,
        @InjectRepository(PplnsGroupMemberEntity)
        private readonly memberRepo: Repository<PplnsGroupMemberEntity>,
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => GroupSoloService))
        private readonly groupSoloService: GroupSoloService,
        @Inject(forwardRef(() => GroupRoundResetService))
        private readonly roundResetService: GroupRoundResetService,
        @Inject(forwardRef(() => BlockpartyService))
        private readonly blockpartyService: BlockpartyService,
    ) {
        const raw = this.configService.get<string>('GROUP_INACTIVITY_KICK_DAYS');
        const parsed = raw ? parseInt(raw, 10) : NaN;
        this.kickInactivityDays = Number.isFinite(parsed) && parsed >= 0
            ? parsed
            : DEFAULT_KICK_INACTIVITY_DAYS;
    }

    async onModuleInit(): Promise<void> {
        await this.rebuildCache();
    }

    /** Full rebuild — called on startup and after any membership change. */
    private async rebuildCache(): Promise<void> {
        const members = await this.memberRepo.find();
        const groupIds = Array.from(new Set(members.map(m => m.groupId)));
        const groups = groupIds.length > 0
            ? await this.groupRepo.find({ where: groupIds.map(id => ({ id, dissolvedAt: IsNull() })) })
            : [];
        const activeById = new Map(groups.map(g => [g.id, g.active]));

        const next = new Map<string, GroupCacheEntry>();
        for (const m of members) {
            const active = activeById.get(m.groupId);
            if (active === undefined) continue; // group dissolved — skip
            next.set(m.address, { groupId: m.groupId, active });
        }
        this.addressCache = next;
    }

    // ── Token helpers ─────────────────────────────────────────────

    private generateToken(): string {
        return 'GRP-' + crypto.randomBytes(24).toString('base64url');
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private verifyToken(providedToken: string, storedHash: string): boolean {
        const providedHash = this.hashToken(providedToken);
        if (providedHash.length !== storedHash.length) return false;
        return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
    }

    async requireAdminToken(groupId: string, token: string | undefined): Promise<PplnsGroupEntity> {
        if (!token) {
            throw new GroupServiceError('missing-token', 'Admin token required');
        }
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) {
            throw new GroupServiceError('not-found', 'Group not found');
        }
        if (!this.verifyToken(token, group.adminTokenHash)) {
            throw new GroupServiceError('invalid-token', 'Invalid admin token');
        }
        return group;
    }

    // ── Lookup ────────────────────────────────────────────────────

    getGroupForAddress(address: string): GroupCacheEntry | undefined {
        return this.addressCache.get(normalizeBtcAddress(address));
    }

    async getGroup(groupId: string): Promise<PplnsGroupEntity | null> {
        return this.groupRepo.findOneBy({ id: groupId });
    }

    async listGroups(): Promise<PplnsGroupEntity[]> {
        return this.groupRepo.find({ where: { dissolvedAt: IsNull() } });
    }

    async listMembers(groupId: string): Promise<PplnsGroupMemberEntity[]> {
        return this.memberRepo.find({ where: { groupId }, order: { joinedAt: 'ASC' } });
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    async createGroup(name: string, creatorAddress: string): Promise<GroupCreateResult> {
        const trimmedName = name?.trim();
        if (!trimmedName || trimmedName.length < 3 || trimmedName.length > 64) {
            throw new GroupServiceError('invalid-name', 'Group name must be 3–64 characters');
        }
        // Control characters (CR, LF, NUL, TAB, …) break email Subject headers
        // — reject them at the create boundary so the group name is safe to
        // interpolate into transactional emails without further escaping.
        if (/[\x00-\x1f\x7f]/.test(trimmedName)) {
            throw new GroupServiceError('invalid-name', 'Group name must not contain control characters');
        }
        const normalizedAddress = normalizeBtcAddress(creatorAddress);
        if (!normalizedAddress) {
            throw new GroupServiceError('invalid-address', 'Creator address required');
        }

        const existingByName = await this.groupRepo.findOneBy({ name: trimmedName });
        if (existingByName && !existingByName.dissolvedAt) {
            throw new GroupServiceError('name-taken', 'Group name already in use');
        }

        const existingMember = await this.memberRepo.findOneBy({ address: normalizedAddress });
        if (existingMember) {
            throw new GroupServiceError('address-in-group', 'Address is already a member of another group');
        }
        this.assertNotInBlockparty(normalizedAddress);

        const adminToken = this.generateToken();
        const group = await this.groupRepo.save(this.groupRepo.create({
            id: crypto.randomUUID(),
            name: trimmedName,
            creatorAddress: normalizedAddress,
            adminTokenHash: this.hashToken(adminToken),
            active: false,
            isPublic: false,
            resetRoundOnBlock: false,
        }));

        await this.memberRepo.save(this.memberRepo.create({
            groupId: group.id,
            address: normalizedAddress,
            role: 'creator',
        }));

        await this.rebuildCache();

        return { group, adminToken };
    }

    async addMember(groupId: string, address: string, token: string | undefined): Promise<PplnsGroupMemberEntity> {
        await this.requireAdminToken(groupId, token);
        return this.addMemberWithoutAdmin(groupId, address);
    }

    /**
     * Add a member bypassing the admin-token check. Intended for callers
     * that have already verified authorization through a different
     * mechanism — currently only the invitation-accept flow, where the
     * invitee proves they own the address by clicking the email link.
     */
    async addMemberWithoutAdmin(groupId: string, address: string): Promise<PplnsGroupMemberEntity> {
        const normalizedAddress = normalizeBtcAddress(address);
        if (!normalizedAddress) {
            throw new GroupServiceError('invalid-address', 'Address required');
        }

        const existing = await this.memberRepo.findOneBy({ address: normalizedAddress });
        if (existing) {
            if (existing.groupId === groupId) {
                throw new GroupServiceError('already-member', 'Address is already in this group');
            }
            throw new GroupServiceError('address-in-group', 'Address is already a member of another group');
        }
        this.assertNotInBlockparty(normalizedAddress);

        // Member cap — the single chokepoint every add path funnels through
        // (directed invite, open invite link, approved join request). NULL =
        // no limit. Enforced server-side so a UI-only block can't be bypassed.
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (group?.maxMembers != null) {
            const count = await this.memberRepo.countBy({ groupId });
            if (count >= group.maxMembers) {
                throw new GroupServiceError('group-full', 'This group has reached its maximum number of members');
            }
        }

        const member = await this.memberRepo.save(this.memberRepo.create({
            groupId,
            address: normalizedAddress,
            role: 'member',
        }));

        await this.recomputeActive(groupId);
        await this.rebuildCache();
        return member;
    }

    /**
     * Remove a non-creator member. The target must be inactive for at least
     * `GROUP_INACTIVITY_KICK_DAYS` days (default 14) measured from their last
     * accepted share, or from `joinedAt` if they never mined. This keeps the
     * admin from unilaterally evicting actively-mining members, while still
     * allowing cleanup of abandoned memberships on long-lived groups.
     *
     * Before the member row is deleted the in-flight round state for that
     * address (Redis shares, rejected counter, pending balance row) is
     * cleared through `GroupSoloService.removeMemberState`, so their work
     * evaporates from the current round and the remaining members' shares
     * grow proportionally on the next block.
     */
    async removeMember(groupId: string, address: string, token: string | undefined): Promise<void> {
        await this.requireAdminToken(groupId, token);
        await this.internalRemove(groupId, address, /*fromCreator*/ true);
    }

    private async internalRemove(groupId: string, address: string, fromCreator: boolean): Promise<void> {
        const member = await this.memberRepo.findOneBy({ groupId, address });
        if (!member) {
            throw new GroupServiceError('not-member', 'Address is not a member of this group');
        }
        if (member.role === 'creator') {
            throw new GroupServiceError(
                'creator-cannot-be-removed',
                'Creator must transfer the role or dissolve the group before being removed',
            );
        }

        const lastActive = await this.groupSoloService.getMemberLastActive(groupId, address);
        const reference = lastActive ?? member.joinedAt;
        const daysSince = (Date.now() - reference) / MS_PER_DAY;
        if (daysSince < this.kickInactivityDays) {
            throw new GroupServiceError(
                'member-still-active',
                `Member has been active within the last ${this.kickInactivityDays} days`,
            );
        }

        // Snapshot the remaining members BEFORE we delete the target — the
        // state-cleanup step splits the kicked miner's pending balance
        // across these addresses, so we need the list before the member
        // row vanishes from the DB.
        const allMembers = await this.memberRepo.find({ where: { groupId } });
        const remainingAddresses = allMembers
            .filter(m => m.address !== address)
            .map(m => m.address);

        // DB-side mutations (member delete + active recompute) atomically:
        // a crash mid-removal that left the member row intact but the
        // group flagged inactive (or vice-versa) was the original H6 bug.
        // Redis state-cleanup runs AFTER the TX commits — if the DB
        // commit fails, no Redis state is touched and the kick is a
        // no-op the admin can retry. If Redis fails after a successful
        // commit, the member is gone in DB; their in-flight round
        // shares are stale until the next round but the source of truth
        // is consistent.
        await this.memberRepo.manager.transaction(async (em) => {
            const memberRepo = em.getRepository(this.memberRepo.target);
            const groupRepo = em.getRepository(this.groupRepo.target);

            await memberRepo.delete({ groupId, address });

            const remaining = await memberRepo.count({ where: { groupId } });
            const grp = await groupRepo.findOneBy({ id: groupId });
            if (grp && !grp.dissolvedAt) {
                const shouldBeActive = remaining >= MIN_MEMBERS_ACTIVE;
                if (grp.active !== shouldBeActive) {
                    grp.active = shouldBeActive;
                    await groupRepo.save(grp);
                }
            }
        });

        try {
            await this.groupSoloService.removeMemberState(groupId, address, remainingAddresses);
        } catch (err) {
            // DB is consistent (member is gone); Redis side may have
            // left stale round-state. Logged so an operator can decide
            // whether to flush manually.
            console.warn(`[GroupService] removeMemberState failed for ${address} in ${groupId} after DB commit:`, (err as Error).message);
        }
        await this.rebuildCache();
    }

    /**
     * Explicit creator handoff with a freshly-issued admin token.
     * The current creator calls this; the new admin token is returned (once).
     */
    async transferCreator(
        groupId: string,
        toAddress: string,
        token: string | undefined,
    ): Promise<{ group: PplnsGroupEntity; adminToken: string }> {
        const group = await this.requireAdminToken(groupId, token);

        // Normalize the target address the same way createGroup / addMember
        // do — bech32 is case-insensitive, and members are stored lowercased.
        // Without this, a caller passing 'BC1Q...' would get 'not-member'
        // against the normalized row in DB, and (worse, if by chance the
        // case matched exactly) creatorAddress would end up in a different
        // case than pplns_group_member.address, diverging from what
        // getGroupForAddress / invitation emails will display.
        const normalizedTo = normalizeBtcAddress(toAddress);
        if (!normalizedTo) {
            throw new GroupServiceError('invalid-address', 'Target address required');
        }

        const newCreator = await this.memberRepo.findOneBy({ groupId, address: normalizedTo });
        if (!newCreator) {
            throw new GroupServiceError('not-member', 'Target address is not a member of this group');
        }
        if (newCreator.role === 'creator') {
            throw new GroupServiceError('already-creator', 'Target is already the creator');
        }

        const oldCreator = await this.memberRepo.findOne({ where: { groupId, role: 'creator' } });
        if (oldCreator) {
            oldCreator.role = 'member';
            await this.memberRepo.save(oldCreator);
        }
        newCreator.role = 'creator';
        await this.memberRepo.save(newCreator);

        const newToken = this.generateToken();
        group.adminTokenHash = this.hashToken(newToken);
        group.creatorAddress = normalizedTo;
        const saved = await this.groupRepo.save(group);

        await this.rebuildCache();
        return { group: saved, adminToken: newToken };
    }

    /**
     * Admin-only PATCH-style update for the round-reset configuration
     * (interval, fire-hour, timezone, finder-bonus). Each field is optional;
     * undefined leaves the column untouched, null clears it.
     *
     * After persistence, re-arms (or unschedules, if interval was cleared)
     * the per-group cron job by calling `roundResetService.applyConfig`.
     * That call is idempotent — safe to invoke even when the config is
     * unchanged from what was already scheduled.
     */
    async updateRoundResetConfig(
        groupId: string,
        settings: GroupRoundResetSettings,
        token: string | undefined,
    ): Promise<PplnsGroupEntity> {
        const group = await this.requireAdminToken(groupId, token);

        // Cross-field consistency: `intervalDays` is only meaningful when
        // preset === 'custom'. A PATCH that sends both a non-custom preset
        // and a positive intervalDays would otherwise persist the dead
        // intervalDays value (cron ignores it for daily/weekly/monthly,
        // but the row pollutes downstream debugging + would re-surface
        // if the preset is later switched back to 'custom').
        if (settings.preset !== undefined
            && settings.preset !== null
            && settings.preset !== 'custom'
            && settings.intervalDays !== undefined
            && settings.intervalDays !== null) {
            throw new GroupServiceError(
                'invalid-interval',
                `intervalDays may only be set when preset === 'custom' (got preset='${settings.preset}', intervalDays=${settings.intervalDays})`,
            );
        }

        // preset — switches calendar cadence (daily/weekly/monthly) vs
        // interval-driven (custom) vs disabled (null). For calendar
        // presets the system aligns to actual calendar boundaries
        // (end-of-day / Monday-start / 1st-of-month) in the admin's TZ,
        // not "every N days from last reset".
        if (settings.preset !== undefined) {
            const v = settings.preset;
            if (v === null) {
                group.roundResetPreset = null;
                group.roundResetIntervalDays = null;
            } else if (v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'custom') {
                group.roundResetPreset = v;
                if (v !== 'custom') {
                    // Calendar presets ignore intervalDays — clear any stale value
                    // so the schedule is unambiguous.
                    group.roundResetIntervalDays = null;
                }
            } else {
                throw new GroupServiceError(
                    'invalid-preset',
                    `roundResetPreset must be one of 'daily','weekly','monthly','custom' or null`,
                );
            }
        }

        // intervalDays — only meaningful when preset='custom'. Validate
        // shape regardless so a bad value is rejected even if the caller
        // hasn't (re-)sent the preset in the same PATCH.
        if (settings.intervalDays !== undefined) {
            if (settings.intervalDays === null) {
                group.roundResetIntervalDays = null;
            } else {
                const v = settings.intervalDays;
                if (!Number.isInteger(v) || v < 1 || v > MAX_RESET_INTERVAL_DAYS) {
                    throw new GroupServiceError(
                        'invalid-interval',
                        `roundResetIntervalDays must be an integer in [1, ${MAX_RESET_INTERVAL_DAYS}] or null`,
                    );
                }
                group.roundResetIntervalDays = v;
            }
        }

        // timezone — must be a valid IANA zone. Cron uses this to fire
        // calendar resets at midnight in the admin's wall-clock.
        if (settings.timezone !== undefined) {
            const v = settings.timezone;
            if (typeof v !== 'string' || v.length === 0 || !isValidTimezone(v)) {
                throw new GroupServiceError(
                    'invalid-timezone',
                    `roundResetTimezone must be a valid IANA timezone (got: ${JSON.stringify(v)})`,
                );
            }
            group.roundResetTimezone = v;
        }
        // hourLocal is no longer admin-configurable — always 00:00 local
        // (= end of previous calendar day/week/month). Defensive: lock
        // any existing entity value to 0 so cron expressions stay
        // consistent with the new semantics.
        group.roundResetHourLocal = 0;

        // finderBonusSats — non-negative integer (sats). Accept string|number|null.
        // Stored as `number` on the entity (sats are well within Number.MAX_SAFE_INTEGER
        // for the configured cap), matches `coinbase-distribution.ts` which expects
        // number-typed sat amounts.
        if (settings.finderBonusSats !== undefined) {
            if (settings.finderBonusSats === null) {
                group.finderBonusSats = 0;
            } else {
                const raw = settings.finderBonusSats;
                let parsed: number;
                if (typeof raw === 'number') {
                    parsed = raw;
                } else if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())) {
                    parsed = Number(raw.trim());
                } else {
                    throw new GroupServiceError(
                        'invalid-bonus',
                        'finderBonusSats must be a non-negative integer (sats)',
                    );
                }
                if (!Number.isFinite(parsed) || !Number.isInteger(parsed)
                    || parsed < 0 || parsed > MAX_FINDER_BONUS_SATS) {
                    throw new GroupServiceError(
                        'invalid-bonus',
                        `finderBonusSats must be in [0, ${MAX_FINDER_BONUS_SATS}] sats`,
                    );
                }
                // Reject sub-minPayout positive bonuses. Without this, the
                // coinbase-distribution math would silently clear the bonus
                // at runtime (`bonusEmitted = cappedBonusSats >= minPayout`)
                // and emit no on-chain output — admin sees the configured
                // value in the UI but no block ever pays it. Better to fail
                // the PATCH so the admin knows their value is too low.
                const minPayoutSats = this.groupSoloService.getMinPayoutSats();
                if (parsed > 0 && parsed < minPayoutSats) {
                    throw new GroupServiceError(
                        'invalid-bonus',
                        `finderBonusSats must be either 0 (disabled) or at least the pool's minimum payout of ${minPayoutSats} sats`,
                    );
                }
                group.finderBonusSats = parsed;
            }
        }

        // isPublic — pure visibility toggle. No cross-field constraints;
        // a group can be public regardless of round-reset config. Strict
        // boolean coercion so malformed JSON ("yes", 1, etc.) doesn't slip
        // into a Postgres BOOLEAN column.
        if (settings.isPublic !== undefined) {
            group.isPublic = settings.isPublic === true;
        }

        // maxMembers — hard member cap. null clears it; a positive integer
        // (min 2, the group floor) sets it. Setting below the current member
        // count is allowed: no one is kicked, growth is just frozen.
        if (settings.maxMembers !== undefined) {
            if (settings.maxMembers === null) {
                group.maxMembers = null;
            } else {
                const v = settings.maxMembers;
                if (!Number.isInteger(v) || v < 2 || v > 100000) {
                    throw new GroupServiceError(
                        'invalid-max-members',
                        'maxMembers must be an integer >= 2 (or null to remove the limit)',
                    );
                }
                group.maxMembers = v;
            }
        }

        // resetRoundOnBlock — opt-in per-block round wipe. Strict boolean
        // coercion so malformed JSON doesn't slip into the BOOLEAN column.
        if (settings.resetRoundOnBlock !== undefined) {
            group.resetRoundOnBlock = settings.resetRoundOnBlock === true;
        }

        // If a preset is configured we need a TZ on the entity — either
        // coming in with this PATCH or already persisted. The TZ is
        // mandatory for both calendar and custom presets because cron
        // needs it to align to the admin's wall-clock. For 'custom' we
        // additionally require an integer interval.
        if (group.roundResetPreset != null) {
            if (!group.roundResetTimezone || !isValidTimezone(group.roundResetTimezone)) {
                throw new GroupServiceError(
                    'incomplete-schedule',
                    'roundResetTimezone must be set when roundResetPreset is set',
                );
            }
            if (group.roundResetPreset === 'custom') {
                if (!group.roundResetIntervalDays
                    || !Number.isInteger(group.roundResetIntervalDays)
                    || group.roundResetIntervalDays < 1
                    || group.roundResetIntervalDays > MAX_RESET_INTERVAL_DAYS) {
                    throw new GroupServiceError(
                        'incomplete-schedule',
                        `roundResetIntervalDays must be set in [1, ${MAX_RESET_INTERVAL_DAYS}] when preset='custom'`,
                    );
                }
            }
        }

        const saved = await this.groupRepo.save(group);

        // (Re-)apply the cron schedule. Idempotent: tears down the existing
        // job and arms a fresh one, OR unschedules entirely when interval
        // was just cleared.
        this.roundResetService.applyConfig(saved);

        return saved;
    }

    async dissolveGroup(groupId: string, token: string | undefined): Promise<void> {
        await this.requireAdminToken(groupId, token);
        await this.dissolveInternal(groupId);
    }

    private async dissolveInternal(groupId: string): Promise<void> {
        // Tear down any scheduled-reset cron job before wiping the group —
        // the firing callback would otherwise self-cleanup on the next tick,
        // but that's up to 24 h of pointless wakeups in the meantime.
        this.roundResetService.unschedule(groupId);
        // Clear all group-solo round state (Redis shares, rejected hash,
        // last-seen hash, pending balance rows) before dropping the members.
        // Without this the keys live forever in Valkey since they carry no
        // TTL, and orphan balance rows would be stranded with a groupId
        // that no longer resolves.
        await this.groupSoloService.removeGroupState(groupId);
        await this.memberRepo.delete({ groupId });
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (group) {
            group.active = false;
            group.dissolvedAt = Date.now();
            await this.groupRepo.save(group);
        }
        await this.rebuildCache();
    }

    /**
     * Reject the address if it's already a member (admin or otherwise)
     * of any active Blockparty. An address can only be in one
     * membership-driven mode at a time.
     */
    private assertNotInBlockparty(address: string): void {
        const blockpartyId = this.blockpartyService.getGroupIdForAddress(address);
        if (blockpartyId) {
            throw new GroupServiceError(
                'address-in-blockparty',
                'Address is already a member of a Blockparty — leave that party first',
            );
        }
    }

    private async recomputeActive(groupId: string): Promise<void> {
        const count = await this.memberRepo.count({ where: { groupId } });
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) return;
        const shouldBeActive = count >= MIN_MEMBERS_ACTIVE;
        if (group.active !== shouldBeActive) {
            group.active = shouldBeActive;
            await this.groupRepo.save(group);
        }
    }
}
