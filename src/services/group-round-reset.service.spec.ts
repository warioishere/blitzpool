import { GroupRoundResetService, cronExprForPreset, computeNextResetAt } from './group-round-reset.service';
import { PplnsGroupEntity } from '../ORM/pplns-group/pplns-group.entity';

/**
 * Unit tests for the per-group round-reset cron driver.
 *
 * Strategy: stub the SchedulerRegistry / GroupSoloService / Repository so
 * we can drive the lifecycle deterministically and reach into the cron-job
 * callback to assert what `fireIfDue` does in each elapsed-time / state
 * combination. The actual `cron` library is used unchanged — we just never
 * let real time advance; instead we yank the registered job and call its
 * stored callback by hand.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeGroup(overrides: Partial<PplnsGroupEntity> = {}): PplnsGroupEntity {
    return {
        id: 'grp-1',
        name: 'Test Group',
        creatorAddress: 'bc1qcreator',
        adminTokenHash: 'hash',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        dissolvedAt: null,
        roundResetPreset: 'custom',
        roundResetIntervalDays: 7,
        roundResetHourLocal: 0,
        roundResetTimezone: 'Europe/Berlin',
        finderBonusSats: 0,
        lastRoundResetAt: null,
        ...overrides,
    } as unknown as PplnsGroupEntity;
}

// Track every CronJob created across tests so afterEach can stop them.
// Without this, jest's event loop stays alive past test completion because
// the real `cron` library schedules a setTimeout for the next firing.
const allRegisteredJobs = new Set<{ stop: () => void }>();

function makeService() {
    const jobs = new Map<string, { stop: () => void; callback: () => void }>();
    const schedulerRegistry: any = {
        addCronJob: jest.fn((name: string, job: any) => {
            jobs.set(name, job);
            allRegisteredJobs.add(job);
        }),
        deleteCronJob: jest.fn((name: string) => {
            const j = jobs.get(name);
            if (!j) throw new Error(`No cron job ${name}`);
            j.stop();
            jobs.delete(name);
        }),
    };

    const groupSoloService: any = {
        scheduledRoundReset: jest.fn(async () => undefined),
    };
    const groupRepo: any = {
        findOneBy: jest.fn(async () => null),
        find: jest.fn(async () => []),
    };

    const service = new GroupRoundResetService(groupRepo, groupSoloService, schedulerRegistry);
    return { service, schedulerRegistry, groupSoloService, groupRepo, jobs };
}

/** Pull the inner callback out of the cron job we just registered. */
function takeCronCallback(jobs: Map<string, any>, groupId: string): () => void {
    const job = jobs.get(`group-reset-${groupId}`);
    if (!job) throw new Error(`No cron job for ${groupId}`);
    // The `cron` library's CronJob exposes `fireOnTick` as the entry point.
    return () => (job as any).fireOnTick();
}

describe('GroupRoundResetService', () => {

    afterEach(() => {
        // Stop every CronJob the tests created so jest can exit cleanly.
        for (const j of allRegisteredJobs) {
            try { j.stop(); } catch { /* already stopped */ }
        }
        allRegisteredJobs.clear();
        jest.restoreAllMocks();
    });

    // ── applyConfig: validation gates ─────────────────────────────────

    it('skips scheduling when group is dissolved', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ dissolvedAt: new Date() }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips scheduling when preset is null', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetPreset: null as any }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips scheduling when preset=custom but interval is invalid', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetPreset: 'custom', roundResetIntervalDays: null as any }));
        service.applyConfig(makeGroup({ roundResetPreset: 'custom', roundResetIntervalDays: 0 }));
        service.applyConfig(makeGroup({ roundResetPreset: 'custom', roundResetIntervalDays: -3 }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips scheduling when timezone is missing', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetTimezone: null as any }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('schedules calendar presets without an interval', () => {
        const { service, schedulerRegistry, jobs } = makeService();
        service.applyConfig(makeGroup({ roundResetPreset: 'daily', roundResetIntervalDays: null as any }));
        service.applyConfig(makeGroup({ id: 'grp-2', roundResetPreset: 'weekly', roundResetIntervalDays: null as any }));
        service.applyConfig(makeGroup({ id: 'grp-3', roundResetPreset: 'monthly', roundResetIntervalDays: null as any }));
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(3);
        expect(jobs.size).toBe(3);
    });

    it('schedules once when config is valid', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup());
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
        expect(schedulerRegistry.addCronJob.mock.calls[0][0]).toBe('group-reset-grp-1');
    });

    it('idempotent: applying twice replaces the previous job (no duplicate)', () => {
        const { service, schedulerRegistry, jobs } = makeService();
        service.applyConfig(makeGroup());
        service.applyConfig(makeGroup({ roundResetPreset: 'weekly', roundResetIntervalDays: null as any }));
        // Each apply: deleteCronJob (no-op on first, real on second), then add.
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
        expect(jobs.size).toBe(1);
    });

    // ── unschedule ────────────────────────────────────────────────────

    it('unschedule is no-op when no job exists', () => {
        const { service, schedulerRegistry } = makeService();
        // SchedulerRegistry.deleteCronJob throws when missing — service must swallow.
        expect(() => service.unschedule('grp-nonexistent')).not.toThrow();
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('group-reset-grp-nonexistent');
    });

    it('unschedule removes the registered job', () => {
        const { service, schedulerRegistry, jobs } = makeService();
        service.applyConfig(makeGroup());
        expect(jobs.size).toBe(1);
        service.unschedule('grp-1');
        expect(jobs.size).toBe(0);
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('group-reset-grp-1');
    });

    // ── fireIfDue: elapsed-since-last gating ──────────────────────────

    it('fireIfDue: never-reset group fires immediately on first tick', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        const group = makeGroup({ lastRoundResetAt: null });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        // Wait one tick so the inner async fireIfDue resolves.
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).toHaveBeenCalledWith('grp-1');
    });

    it('fireIfDue: too-early tick skips reset', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        // 7-day interval, 12h tolerance → due threshold is 6.5 days. Set
        // lastRoundResetAt 3 days ago: clearly too early.
        const recent = new Date(Date.now() - 3 * DAY_MS);
        const group = makeGroup({ lastRoundResetAt: recent });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).not.toHaveBeenCalled();
    });

    it('fireIfDue: interval elapsed → reset fires', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        // 7-day interval, last reset 8 days ago.
        const old = new Date(Date.now() - 8 * DAY_MS);
        const group = makeGroup({ lastRoundResetAt: old });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).toHaveBeenCalledWith('grp-1');
    });

    it('fireIfDue: DST tolerance — fires when elapsed is within 12h short of interval', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        // 7-day interval, last reset 6.6 days ago. With 12h tolerance the
        // due-threshold is 6.5 days, so this should fire.
        const elapsed = 6.6 * DAY_MS;
        const last = new Date(Date.now() - elapsed);
        const group = makeGroup({ lastRoundResetAt: last });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).toHaveBeenCalledWith('grp-1');
    });

    it('fireIfDue: tolerance edge — does NOT fire at 6.4 days', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        // 7-day interval, 12h tolerance → 6.5d threshold. 6.4 days elapsed → too early.
        const last = new Date(Date.now() - 6.4 * DAY_MS);
        const group = makeGroup({ lastRoundResetAt: last });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).not.toHaveBeenCalled();
    });

    it('fireIfDue: dissolved group → unschedules itself, does not reset', async () => {
        const { service, groupRepo, groupSoloService, schedulerRegistry, jobs } = makeService();
        const group = makeGroup({ dissolvedAt: new Date() });
        // applyConfig short-circuits on dissolve, so register manually via
        // a non-dissolved view first, then return the dissolved view from
        // findOneBy to simulate "dissolved between schedule and tick".
        service.applyConfig(makeGroup());
        groupRepo.findOneBy.mockResolvedValue(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).not.toHaveBeenCalled();
        // Self-cleanup: job was deleted from the registry on the dissolved tick.
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('group-reset-grp-1');
    });

    it('fireIfDue: cleared preset → unschedules itself', async () => {
        const { service, groupRepo, groupSoloService, schedulerRegistry, jobs } = makeService();
        service.applyConfig(makeGroup());
        // Admin cleared the preset between firings.
        groupRepo.findOneBy.mockResolvedValue(makeGroup({ roundResetPreset: null as any }));

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).not.toHaveBeenCalled();
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('group-reset-grp-1');
    });

    it('fireIfDue: calendar preset fires unconditionally on every tick', async () => {
        const { service, groupRepo, groupSoloService, jobs } = makeService();
        // Daily preset, no elapsed-check applies. Even if last reset was
        // 1 minute ago, the cron firing IS the calendar boundary reset.
        const group = makeGroup({
            roundResetPreset: 'daily',
            roundResetIntervalDays: null as any,
            lastRoundResetAt: new Date(Date.now() - 60 * 1000), // 1 min ago
        });
        groupRepo.findOneBy.mockResolvedValue(group);
        service.applyConfig(group);

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).toHaveBeenCalledWith('grp-1');
        // Note: the 60-s anti-double-fire guard is in scheduledRoundReset
        // itself (GroupSoloService), not here. fireIfDue's job is to fire
        // calendar resets without elapsed math.
    });

    // ── Bootstrap ─────────────────────────────────────────────────────

    it('onApplicationBootstrap loads all configured groups and schedules them', async () => {
        const { service, schedulerRegistry, groupRepo } = makeService();
        groupRepo.find.mockResolvedValue([
            makeGroup({ id: 'grp-1' }),
            makeGroup({ id: 'grp-2', roundResetPreset: 'daily', roundResetIntervalDays: null as any }),
            makeGroup({ id: 'grp-3', roundResetPreset: 'weekly', roundResetIntervalDays: null as any, roundResetTimezone: 'America/New_York' }),
        ]);
        await service.onApplicationBootstrap();
        expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(3);
        const names = schedulerRegistry.addCronJob.mock.calls.map((c: any[]) => c[0]);
        expect(names).toEqual(expect.arrayContaining([
            'group-reset-grp-1', 'group-reset-grp-2', 'group-reset-grp-3',
        ]));
    });

    it('onApplicationBootstrap continues past a single group failing to schedule', async () => {
        const { service, schedulerRegistry, groupRepo } = makeService();
        groupRepo.find.mockResolvedValue([
            makeGroup({ id: 'grp-1' }),
            makeGroup({ id: 'grp-2', roundResetTimezone: 'NOT_A_REAL_TZ' }),
            makeGroup({ id: 'grp-3' }),
        ]);
        await service.onApplicationBootstrap();
        // grp-2 throws inside scheduleForGroup; grp-1 and grp-3 should still register.
        const names = schedulerRegistry.addCronJob.mock.calls.map((c: any[]) => c[0]);
        expect(names).toContain('group-reset-grp-1');
        expect(names).toContain('group-reset-grp-3');
    });

    // ── cronExprForPreset ─────────────────────────────────────────────

    describe('cronExprForPreset', () => {
        it('daily → fires every day at 00:00', () => {
            expect(cronExprForPreset('daily')).toBe('0 0 0 * * *');
        });
        it('weekly → fires on Monday at 00:00 (= end of Sunday)', () => {
            expect(cronExprForPreset('weekly')).toBe('0 0 0 * * 1');
        });
        it('monthly → fires on day 1 at 00:00 (= end of previous month)', () => {
            expect(cronExprForPreset('monthly')).toBe('0 0 0 1 * *');
        });
        it('custom → fires daily, fireIfDue gates with elapsed-check', () => {
            expect(cronExprForPreset('custom')).toBe('0 0 0 * * *');
        });
    });

    // ── computeNextResetAt ────────────────────────────────────────────
    //
    // The exact timestamp depends on "now" in real time, so the assertions
    // here check structural properties: timestamp is in the future, lands
    // on the right calendar boundary in the configured TZ, and respects
    // the elapsed gate for custom presets.

    describe('computeNextResetAt', () => {
        const TZ = 'Europe/Berlin';

        const partsInTz = (d: Date) => {
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: TZ,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                weekday: 'short', hour12: false,
            }).formatToParts(d);
            const get = (n: string) => fmt.find(p => p.type === n)!.value;
            return {
                hour: parseInt(get('hour'), 10),
                minute: parseInt(get('minute'), 10),
                second: parseInt(get('second'), 10),
                day: parseInt(get('day'), 10),
                weekday: get('weekday'),
            };
        };

        it('returns null when preset is not set', () => {
            expect(computeNextResetAt(makeGroup({ roundResetPreset: null as any }))).toBeNull();
        });

        it('returns null when group is dissolved', () => {
            expect(computeNextResetAt(makeGroup({ dissolvedAt: new Date() }))).toBeNull();
        });

        it('returns null when timezone is missing', () => {
            expect(computeNextResetAt(makeGroup({
                roundResetPreset: 'daily', roundResetTimezone: null as any,
            }))).toBeNull();
        });

        it('daily: next 00:00 in TZ', () => {
            const next = computeNextResetAt(makeGroup({
                roundResetPreset: 'daily',
                roundResetIntervalDays: null as any,
                roundResetTimezone: TZ,
            }));
            expect(next).not.toBeNull();
            expect(next!.getTime()).toBeGreaterThan(Date.now());
            const p = partsInTz(next!);
            expect(p.hour).toBe(0);
            expect(p.minute).toBe(0);
            expect(p.second).toBe(0);
        });

        it('weekly: next Monday 00:00 in TZ', () => {
            const next = computeNextResetAt(makeGroup({
                roundResetPreset: 'weekly',
                roundResetIntervalDays: null as any,
                roundResetTimezone: TZ,
            }));
            expect(next).not.toBeNull();
            const p = partsInTz(next!);
            expect(p.hour).toBe(0);
            expect(p.weekday).toBe('Mon');
        });

        it('monthly: next 1st of month 00:00 in TZ', () => {
            const next = computeNextResetAt(makeGroup({
                roundResetPreset: 'monthly',
                roundResetIntervalDays: null as any,
                roundResetTimezone: TZ,
            }));
            expect(next).not.toBeNull();
            const p = partsInTz(next!);
            expect(p.hour).toBe(0);
            expect(p.day).toBe(1);
        });

        it('custom: never-reset → next 00:00 in TZ (immediate)', () => {
            const next = computeNextResetAt(makeGroup({
                roundResetPreset: 'custom',
                roundResetIntervalDays: 7,
                roundResetTimezone: TZ,
                lastRoundResetAt: null,
            }));
            expect(next).not.toBeNull();
            const p = partsInTz(next!);
            expect(p.hour).toBe(0);
            // First daily fire from now → ≤ 24h away
            expect(next!.getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1000);
        });

        it('custom: lastResetAt 3d ago + 7d interval → next reset >= ~4d from now', () => {
            const last = new Date(Date.now() - 3 * DAY_MS);
            const next = computeNextResetAt(makeGroup({
                roundResetPreset: 'custom',
                roundResetIntervalDays: 7,
                roundResetTimezone: TZ,
                lastRoundResetAt: last,
            }));
            expect(next).not.toBeNull();
            // Threshold = lastResetAt + 7d - 12h tolerance.
            // last = now - 3d. So earliest = now + 3.5d.
            // Next reset must be at the next 00:00 TZ AT OR AFTER that, ≤ 4.5d from now.
            const delta = next!.getTime() - Date.now();
            expect(delta).toBeGreaterThanOrEqual(3.5 * DAY_MS - 25 * HOUR_MS); // -25h covers TZ skew
            expect(delta).toBeLessThanOrEqual(5 * DAY_MS);
        });

        it('custom invalid interval → null', () => {
            expect(computeNextResetAt(makeGroup({
                roundResetPreset: 'custom',
                roundResetIntervalDays: null as any,
                roundResetTimezone: TZ,
            }))).toBeNull();
        });
    });
});
