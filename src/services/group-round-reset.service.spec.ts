import { GroupRoundResetService } from './group-round-reset.service';
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
        roundResetIntervalDays: 7,
        roundResetHourLocal: 3,
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

    it('skips scheduling when interval is null/0/negative', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetIntervalDays: null as any }));
        service.applyConfig(makeGroup({ roundResetIntervalDays: 0 }));
        service.applyConfig(makeGroup({ roundResetIntervalDays: -3 }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips scheduling when hour is out of [0,23]', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetHourLocal: -1 }));
        service.applyConfig(makeGroup({ roundResetHourLocal: 24 }));
        service.applyConfig(makeGroup({ roundResetHourLocal: 3.5 }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips scheduling when timezone is missing', () => {
        const { service, schedulerRegistry } = makeService();
        service.applyConfig(makeGroup({ roundResetTimezone: null as any }));
        expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
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
        service.applyConfig(makeGroup({ roundResetHourLocal: 5 }));
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

    it('fireIfDue: cleared interval → unschedules itself', async () => {
        const { service, groupRepo, groupSoloService, schedulerRegistry, jobs } = makeService();
        service.applyConfig(makeGroup());
        // Admin cleared the interval between firings.
        groupRepo.findOneBy.mockResolvedValue(makeGroup({ roundResetIntervalDays: null as any }));

        const tick = takeCronCallback(jobs, 'grp-1');
        tick();
        await new Promise(setImmediate);
        expect(groupSoloService.scheduledRoundReset).not.toHaveBeenCalled();
        expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('group-reset-grp-1');
    });

    // ── Bootstrap ─────────────────────────────────────────────────────

    it('onApplicationBootstrap loads all configured groups and schedules them', async () => {
        const { service, schedulerRegistry, groupRepo } = makeService();
        groupRepo.find.mockResolvedValue([
            makeGroup({ id: 'grp-1' }),
            makeGroup({ id: 'grp-2', roundResetHourLocal: 5 }),
            makeGroup({ id: 'grp-3', roundResetTimezone: 'America/New_York' }),
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
});
