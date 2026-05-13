import { Injectable, Logger, OnApplicationBootstrap, Inject, forwardRef } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { CronJob } from 'cron';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';
import { GroupSoloService } from './group-solo.service';

/**
 * Drives the per-group scheduled round-reset cron jobs.
 *
 * Each group with a non-NULL `roundResetPreset` gets its own
 * cron job, registered with `SchedulerRegistry`, that fires at
 * calendar boundaries in the group's `roundResetTimezone`:
 *
 *   - 'daily'   → 00:00 every day            (cron `0 0 0 * * *`)
 *   - 'weekly'  → 00:00 on Monday            (cron `0 0 0 * * 1`)
 *   - 'monthly' → 00:00 on day 1 of month    (cron `0 0 0 1 * *`)
 *   - 'custom'  → 00:00 every day, gated by elapsed-check on
 *                 `roundResetIntervalDays`   (cron `0 0 0 * * *`)
 *
 * Calendar presets fire exactly at the wall-clock boundary in
 * the admin's TZ — daily resets at end-of-day, weekly at end-of-
 * Sunday, monthly at end-of-month including the 28/29/30/31-day
 * variation. No "every N days from creation" approximation.
 *
 * Lifecycle (called from GroupService / settings controller):
 *   - applyConfig(group)   — after group create / settings update
 *   - unschedule(groupId)  — after group dissolve
 *
 * For 'custom', a 12 h DST tolerance absorbs the skew where the
 * daily fire lands 23 h or 25 h after the previous one. Calendar
 * presets are tolerance-free because cron itself is calendar-aware.
 */
/** Tolerance against the configured interval (ms), absorbs DST skew. */
const DST_TOLERANCE_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class GroupRoundResetService implements OnApplicationBootstrap {

    private readonly logger = new Logger(GroupRoundResetService.name);

    constructor(
        @InjectRepository(PplnsGroupEntity)
        private readonly groupRepo: Repository<PplnsGroupEntity>,
        @Inject(forwardRef(() => GroupSoloService))
        private readonly groupSoloService: GroupSoloService,
        private readonly schedulerRegistry: SchedulerRegistry,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        // Load every active group with a configured preset and arm its
        // cron job. Groups without a preset stay silent.
        const groups = await this.groupRepo.find({
            where: {
                dissolvedAt: IsNull(),
                roundResetPreset: Not(IsNull()),
            },
        });
        let scheduled = 0;
        for (const g of groups) {
            try {
                this.scheduleForGroup(g);
                scheduled++;
            } catch (err) {
                this.logger.error(
                    `failed to schedule reset for group ${g.id}: ${(err as Error).message}`,
                );
            }
        }
        this.logger.log(`Scheduled ${scheduled} group round-reset cron job(s) on bootstrap`);
    }

    /**
     * (Re-)schedule a group's reset job from its current entity state.
     * Idempotent: silently replaces an existing job for the same group.
     * Removes the job entirely when the group has no preset configured
     * (admin cleared the setting).
     */
    applyConfig(group: PplnsGroupEntity): void {
        // Always start clean — handles "preset changed" / "TZ changed"
        // by tearing down the old job before deciding whether to arm a
        // new one.
        this.unschedule(group.id);

        if (group.dissolvedAt) return;
        if (!group.roundResetPreset) return;
        if (!group.roundResetTimezone) return;
        if (group.roundResetPreset === 'custom') {
            // Custom requires an interval; without it the cron has no
            // meaning. Stay silent rather than fire daily forever.
            if (!group.roundResetIntervalDays || group.roundResetIntervalDays < 1) return;
        }

        this.scheduleForGroup(group);
    }

    /**
     * Tear down the cron job for a group (no-op if none scheduled).
     * Called from GroupService.dissolveInternal and applyConfig.
     */
    unschedule(groupId: string): void {
        const name = this.cronJobName(groupId);
        try {
            // SchedulerRegistry throws if the job doesn't exist; suppress
            // since this is also called as a clean-up on every applyConfig.
            this.schedulerRegistry.deleteCronJob(name);
        } catch {
            // not scheduled — fine
        }
    }

    /** Build the cron job and register it. Caller must ensure config is valid. */
    private scheduleForGroup(group: PplnsGroupEntity): void {
        const tz = group.roundResetTimezone!;
        const groupId = group.id;
        const cronExpr = cronExprForPreset(group.roundResetPreset!);

        const job = new CronJob(
            cronExpr,
            () => {
                // Run the reset out-of-band so the cron tick isn't
                // blocked on DB / Redis I/O.
                this.fireIfDue(groupId).catch(err => this.logger.error(
                    `reset firing failed for ${groupId}: ${(err as Error).message}`,
                ));
            },
            null,
            true,    // start
            tz,      // timezone
        );

        this.schedulerRegistry.addCronJob(this.cronJobName(groupId), job);
        const intervalSuffix = group.roundResetPreset === 'custom'
            ? `, interval=${group.roundResetIntervalDays}d`
            : '';
        this.logger.log(
            `scheduled group ${groupId}: preset=${group.roundResetPreset} '${cronExpr}' in ${tz}${intervalSuffix}`,
        );
    }

    /**
     * Cron-callback body: load the fresh group state and decide whether
     * to fire the reset. Loading fresh on every fire (rather than
     * capturing the entity in a closure) means settings changes pick
     * up on the next firing without re-arming.
     *
     * For calendar presets every firing IS the reset (cron is already
     * calendar-aligned). For 'custom' the elapsed-check decides whether
     * the configured interval has been reached.
     */
    private async fireIfDue(groupId: string): Promise<void> {
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) {
            // Group was dissolved between the cron arming and this firing —
            // tear down our own job so it doesn't run again.
            this.unschedule(groupId);
            return;
        }
        if (!group.roundResetPreset) {
            // Admin cleared the setting between firings.
            this.unschedule(groupId);
            return;
        }

        if (group.roundResetPreset === 'custom') {
            const intervalDays = group.roundResetIntervalDays ?? 0;
            if (intervalDays < 1) {
                this.unschedule(groupId);
                return;
            }
            const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
            const elapsedMs = group.lastRoundResetAt
                ? Date.now() - group.lastRoundResetAt
                : Number.POSITIVE_INFINITY;  // never reset → fire immediately
            const dueThreshold = intervalMs - DST_TOLERANCE_MS;

            if (elapsedMs < dueThreshold) {
                // Too early — daily-fire ticked but the configured interval
                // hasn't elapsed yet. Wait for a future firing.
                return;
            }
        }
        // Calendar presets fall through unconditionally — the cron only
        // fires at the configured calendar boundary.

        await this.groupSoloService.scheduledRoundReset(groupId);
    }

    private cronJobName(groupId: string): string {
        return `group-reset-${groupId}`;
    }
}

/**
 * Cron expressions for each preset. All fire at 00:00 in the
 * group's TZ — calendar presets pick the calendar-aligned day,
 * custom fires every day and lets `fireIfDue` gate on elapsed
 * time.
 */
export function cronExprForPreset(preset: 'daily' | 'weekly' | 'monthly' | 'custom'): string {
    switch (preset) {
        case 'daily':   return '0 0 0 * * *';   // every day at 00:00
        case 'weekly':  return '0 0 0 * * 1';   // every Monday at 00:00 (= end of Sunday)
        case 'monthly': return '0 0 0 1 * *';   // 1st of every month at 00:00 (= end of month)
        case 'custom':  return '0 0 0 * * *';   // daily fire, gated by fireIfDue elapsed-check
        // Defence-in-depth: the union above is exhaustive for typed
        // callers, but a DB row whose `roundResetPreset` drifted out of
        // range (manual SQL, future enum addition without code update)
        // would otherwise silently return `undefined` and crash the
        // CronJob constructor with a confusing message. Fail loudly here.
        default: {
            const exhaustiveCheck: never = preset;
            throw new Error(`cronExprForPreset: unknown preset '${exhaustiveCheck}'`);
        }
    }
}

/**
 * Compute the wall-clock timestamp of the next scheduled reset
 * for a group, or null if the schedule is disabled. Used by the
 * public group-view endpoint so the UI can show an exact countdown
 * to the next reset (no client-side TZ math required).
 *
 * For calendar presets the next reset is exactly the next cron
 * fire (00:00 in the group's TZ on the appropriate calendar
 * boundary). For 'custom' it's the first daily cron fire at or
 * after `lastRoundResetAt + intervalDays - DST tolerance`; this
 * matches the gate inside `fireIfDue` so the displayed time and
 * the actual fire time agree.
 */
export function computeNextResetAt(group: PplnsGroupEntity): Date | null {
    if (!group.roundResetPreset) return null;
    if (!group.roundResetTimezone) return null;
    if (group.dissolvedAt) return null;
    if (group.roundResetPreset === 'custom') {
        if (!group.roundResetIntervalDays || group.roundResetIntervalDays < 1) return null;
    }

    const cronExpr = cronExprForPreset(group.roundResetPreset);
    // start=false → just used as a calculator, never actually fires.
    const tempJob = new CronJob(cronExpr, () => {}, null, false, group.roundResetTimezone);

    if (group.roundResetPreset !== 'custom') {
        return tempJob.nextDate().toJSDate();
    }

    // Custom: walk forward through daily fires; pick the first one
    // at or after the elapsed-due threshold.
    const intervalMs = group.roundResetIntervalDays! * 24 * 60 * 60 * 1000;
    const earliestMs = group.lastRoundResetAt
        ? group.lastRoundResetAt + intervalMs - DST_TOLERANCE_MS
        : Date.now();
    const lookaheadDays = group.roundResetIntervalDays! + 2; // +2 covers DST + boundary
    const upcoming = tempJob.nextDates(lookaheadDays);
    for (const d of upcoming) {
        const ms = d.toJSDate().getTime();
        if (ms >= earliestMs) return d.toJSDate();
    }
    return upcoming.length > 0
        ? upcoming[upcoming.length - 1].toJSDate()
        : null;
}
