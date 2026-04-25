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
 * Each group with non-NULL `roundResetIntervalDays` gets its own
 * cron job, registered with `SchedulerRegistry`, that fires daily
 * at the group's configured `roundResetHourLocal` in the group's
 * `roundResetTimezone`. The job's callback checks whether enough
 * time has elapsed since `lastRoundResetAt` (with a DST tolerance)
 * and, if yes, calls `GroupSoloService.scheduledRoundReset(groupId)`
 * which performs the Variant-B "wipe everything" sequence.
 *
 * Why daily-fire + elapsed-check instead of "every N days" cron:
 *   cron natively supports "every Sunday" (interval=7) and "1st of
 *   the month" (interval≈30) but not arbitrary "every N days from
 *   creation". Firing daily and checking the elapsed time is the
 *   simplest way to support any integer interval uniformly.
 *
 * Lifecycle (called from GroupService / settings controller):
 *   - applyConfig(group)   — after group create / settings update
 *   - unschedule(groupId)  — after group dissolve
 *
 * Tolerance: a 12 h skew off the configured interval is allowed
 * before firing — covers DST transitions where the daily fire-time
 * lands 23 h or 25 h after the previous one.
 */
@Injectable()
export class GroupRoundResetService implements OnApplicationBootstrap {

    private readonly logger = new Logger(GroupRoundResetService.name);

    /** Tolerance against the configured interval (ms), absorbs DST skew. */
    private static readonly DST_TOLERANCE_MS = 12 * 60 * 60 * 1000;

    constructor(
        @InjectRepository(PplnsGroupEntity)
        private readonly groupRepo: Repository<PplnsGroupEntity>,
        @Inject(forwardRef(() => GroupSoloService))
        private readonly groupSoloService: GroupSoloService,
        private readonly schedulerRegistry: SchedulerRegistry,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        // Load every active group with a configured reset interval and
        // arm its cron job. Groups without configuration stay silent.
        const groups = await this.groupRepo.find({
            where: {
                dissolvedAt: IsNull(),
                roundResetIntervalDays: Not(IsNull()),
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
     * Removes the job entirely when the group has no interval configured
     * (admin cleared the setting).
     */
    applyConfig(group: PplnsGroupEntity): void {
        // Always start clean — handles "interval changed" / "TZ changed"
        // by tearing down the old job before deciding whether to arm a
        // new one.
        this.unschedule(group.id);

        if (group.dissolvedAt) return;
        if (!group.roundResetIntervalDays || group.roundResetIntervalDays < 1) return;
        if (!Number.isInteger(group.roundResetHourLocal)
            || group.roundResetHourLocal! < 0
            || group.roundResetHourLocal! > 23) return;
        if (!group.roundResetTimezone) return;

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
        const hour = group.roundResetHourLocal!;
        const tz = group.roundResetTimezone!;
        const groupId = group.id;
        // Fire daily at the configured local hour. The elapsed-since-last
        // check inside the callback gates which firings actually run a
        // reset (every N-th, where N = interval).
        const cronExpr = `0 0 ${hour} * * *`;

        const job = new CronJob(
            cronExpr,
            () => {
                // Run the elapsed-check + reset out-of-band so the cron
                // tick isn't blocked on DB / Redis I/O.
                this.fireIfDue(groupId).catch(err => this.logger.error(
                    `reset firing failed for ${groupId}: ${(err as Error).message}`,
                ));
            },
            null,
            true,    // start
            tz,      // timezone
        );

        this.schedulerRegistry.addCronJob(this.cronJobName(groupId), job);
        this.logger.log(
            `scheduled group ${groupId}: '${cronExpr}' in ${tz}, ` +
            `interval=${group.roundResetIntervalDays}d`,
        );
    }

    /**
     * Cron-callback body: load the fresh group state and decide whether
     * to fire the reset based on `lastRoundResetAt`. Loading fresh on
     * every fire (rather than capturing the entity in a closure) means
     * settings changes pick up on the next firing without re-arming.
     */
    private async fireIfDue(groupId: string): Promise<void> {
        const group = await this.groupRepo.findOneBy({ id: groupId });
        if (!group || group.dissolvedAt) {
            // Group was dissolved between the cron arming and this firing —
            // tear down our own job so it doesn't run again.
            this.unschedule(groupId);
            return;
        }
        if (!group.roundResetIntervalDays || group.roundResetIntervalDays < 1) {
            // Admin cleared the setting between firings.
            this.unschedule(groupId);
            return;
        }

        const intervalMs = group.roundResetIntervalDays * 24 * 60 * 60 * 1000;
        const elapsedMs = group.lastRoundResetAt
            ? Date.now() - group.lastRoundResetAt.getTime()
            : Number.POSITIVE_INFINITY;  // never reset → fire immediately
        const dueThreshold = intervalMs - GroupRoundResetService.DST_TOLERANCE_MS;

        if (elapsedMs < dueThreshold) {
            // Too early — daily-fire ticked but the configured interval
            // hasn't elapsed yet. Wait for a future firing.
            return;
        }

        await this.groupSoloService.scheduledRoundReset(groupId);
    }

    private cronJobName(groupId: string): string {
        return `group-reset-${groupId}`;
    }
}
