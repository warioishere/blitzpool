jest.mock('node-telegram-bot-api', () => jest.fn());

import { CoinbaseCapacityMonitorService } from './coinbase-capacity-monitor.service';

/**
 * Tests the threshold-decision + dedup state machine of the capacity
 * monitor. Mocks out the downstream services so we isolate the logic:
 *
 *   - runChecks() must fire an email exactly once per upward crossing
 *   - repeats at the same level within 24h must stay silent
 *   - a warning ↔ urgent escalation must fire
 *   - a recovery to 'below' must fire exactly once
 *   - disabled (no admin email) short-circuits the whole path
 *
 * The email sender is a spy; we assert on its .mock.calls[][0] to check
 * the payload that would go out, without actually hitting SMTP.
 *
 * We bypass the strict-tuple-typed .mock.calls via a small helper so the
 * test reads naturally without sprinkling ! / as any at every call site.
 */
const callArg = (spy: jest.Mock, i: number): any => (spy.mock.calls as any[][])[i][0];
function createMonitor(opts: {
    adminEmail?: string | undefined;
    envEnabled?: string;
    warnThreshold?: string;
    urgentThreshold?: string;
    pplnsMiners?: number;
    maxOutputs?: number;
    budget?: number;
    groups?: Array<{ id: string; name: string; active: boolean; miners: number }>;
    pplnsEnabled?: boolean;
    groupSoloEnabled?: boolean;
} = {}) {
    const env: Record<string, string | undefined> = {
        POOL_ADMIN_EMAIL: opts.adminEmail ?? 'ops@example.com',
        POOL_CAPACITY_ALERT_ENABLED: opts.envEnabled ?? 'true',
        POOL_CAPACITY_ALERT_THRESHOLD: opts.warnThreshold ?? '0.8',
        POOL_CAPACITY_ALERT_URGENT_THRESHOLD: opts.urgentThreshold ?? '0.95',
    };
    const config = { get: jest.fn((k: string) => env[k]) };

    // Mutable state so tests can reconfigure between runChecks()
    const state = {
        pplnsMiners: opts.pplnsMiners ?? 0,
        maxOutputs: opts.maxOutputs ?? 100,
        budget: opts.budget ?? 50000,
        groups: opts.groups ?? [],
        pplnsEnabled: opts.pplnsEnabled ?? true,
        groupSoloEnabled: opts.groupSoloEnabled ?? true,
    };

    const redisStore = new Map<string, string>();
    const redis = {
        get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
        set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); }),
        del: jest.fn(async (k: string) => { redisStore.delete(k); }),
    };
    const cacheManager = { store: { client: redis } };

    const pplnsService = {
        isEnabled: () => state.pplnsEnabled,
        getCurrentDistribution: async () => Array.from({ length: state.pplnsMiners }, (_, i) => ({
            address: `bc1qminer${i}`,
            totalShares: 1,
            percent: 0,
        })),
        getMaxCoinbaseOutputs: () => state.maxOutputs,
        getFeeConfig: () => ({ feePercent: 2, feeAddress: 'bc1qfee', coinbaseWeightBudget: state.budget }),
    };
    const groupService = {
        listGroups: async () => state.groups.map(g => ({ id: g.id, name: g.name, active: g.active })),
    };
    const groupSoloService = {
        isEnabled: () => state.groupSoloEnabled,
        getRoundStats: async (groupId: string) => {
            const g = state.groups.find(g => g.id === groupId);
            return {
                totalShares: 0,
                totalRejected: 0,
                perAddress: Array.from({ length: g?.miners ?? 0 }, (_, i) => ({
                    address: `bc1qg${groupId}m${i}`,
                    totalShares: 0,
                    percent: 0,
                    totalRejected: 0,
                })),
            };
        },
    };
    const emailService = {
        sendCapacityAlert: jest.fn(async () => undefined),
    };

    const service = new CoinbaseCapacityMonitorService(
        config as any,
        cacheManager as any,
        pplnsService as any,
        groupService as any,
        groupSoloService as any,
        emailService as any,
    );
    service.onModuleInit();

    return { service, emailService, redisStore, state };
}

describe('CoinbaseCapacityMonitorService', () => {
    const MAX = 100;

    it('does nothing when POOL_ADMIN_EMAIL is empty', async () => {
        const { service, emailService } = createMonitor({ adminEmail: '', pplnsMiners: 99, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).not.toHaveBeenCalled();
    });

    it('does nothing when POOL_CAPACITY_ALERT_ENABLED=false', async () => {
        const { service, emailService } = createMonitor({ envEnabled: 'false', pplnsMiners: 99, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).not.toHaveBeenCalled();
    });

    it('stays silent while below the warning threshold', async () => {
        // 50 of 100 miners = 50 %, below 80 % warning.
        const { service, emailService } = createMonitor({ pplnsMiners: 50, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).not.toHaveBeenCalled();
    });

    it('fires a warning when crossing the warning threshold', async () => {
        // 82 / 100 = 82 %.
        const { service, emailService } = createMonitor({ pplnsMiners: 82, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
        const call = callArg(emailService.sendCapacityAlert, 0);
        expect(call.level).toBe('warning');
        expect(call.scope).toBe('PPLNS main pool');
        expect(call.current).toBe(82);
        expect(call.max).toBe(100);
        expect(call.threshold).toBeCloseTo(0.8);
    });

    it('does not re-fire on a second run at the same warning level (dedup)', async () => {
        const { service, emailService, state } = createMonitor({ pplnsMiners: 82, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
        // Same level next cycle — silent.
        state.pplnsMiners = 85;
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
    });

    it('escalates warning → urgent as a new alert', async () => {
        const { service, emailService, state } = createMonitor({ pplnsMiners: 82, maxOutputs: MAX });
        await service.runChecks();
        state.pplnsMiners = 97; // crosses 95 %
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);
        expect(callArg(emailService.sendCapacityAlert, 1).level).toBe('urgent');
    });

    it('does NOT fire again when urgent → warning (deescalation is silent)', async () => {
        const { service, emailService, state } = createMonitor({ pplnsMiners: 97, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
        // Back down to warning — avoid flip-flop spam.
        state.pplnsMiners = 85;
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
    });

    it('fires recovery exactly once when dropping to below', async () => {
        const { service, emailService, state } = createMonitor({ pplnsMiners: 82, maxOutputs: MAX });
        await service.runChecks();
        state.pplnsMiners = 40;
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);
        expect(callArg(emailService.sendCapacityAlert, 1).level).toBe('recovery');
        // A third run while still below → silent.
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);
    });

    it('sends a daily reminder after 24h at the same warning level', async () => {
        const { service, emailService, redisStore } = createMonitor({ pplnsMiners: 82, maxOutputs: MAX });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);

        // Force lastSentAt to 25 hours ago directly in Redis.
        const key = 'pool:capacity-alert:pplns';
        const stale = { level: 'warning', lastSentAt: Date.now() - 25 * 60 * 60 * 1000 };
        redisStore.set(key, JSON.stringify(stale));

        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);
    });

    it('uses the live coinbaseWeightBudget in the alert payload', async () => {
        const { service, emailService } = createMonitor({
            pplnsMiners: 82,
            maxOutputs: MAX,
            budget: 123456,
        });
        await service.runChecks();
        const call = callArg(emailService.sendCapacityAlert, 0);
        expect(call.coinbaseWeightBudget).toBe(123456);
        expect(call.envVarName).toBe('PPLNS_COINBASE_WEIGHT_BUDGET');
    });

    it('also checks active groups and skips inactive ones', async () => {
        const { service, emailService } = createMonitor({
            pplnsMiners: 10, // below warning
            maxOutputs: MAX,
            groups: [
                { id: 'active-1', name: 'Hot Group', active: true, miners: 90 }, // 90 %
                { id: 'inactive-1', name: 'Cold Group', active: false, miners: 99 },
            ],
        });
        await service.runChecks();
        // Only the active group fires.
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
        const call = callArg(emailService.sendCapacityAlert, 0);
        expect(call.scope).toBe('Group "Hot Group"');
        expect(call.current).toBe(90);
    });

    it('fires PPLNS + per-group alerts with independent dedup state', async () => {
        const { service, emailService, state } = createMonitor({
            pplnsMiners: 82,
            maxOutputs: MAX,
            groups: [{ id: 'g1', name: 'Group One', active: true, miners: 85 }],
        });
        await service.runChecks();
        // PPLNS fires + group fires = 2 total.
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);
        const scopes = (emailService.sendCapacityAlert.mock.calls as any[][]).map(c => c[0].scope).sort();
        expect(scopes).toEqual(['Group "Group One"', 'PPLNS main pool']);

        // Second run: everyone's still at the same level → silent.
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(2);

        // Drop PPLNS below 80 %: only its recovery fires.
        state.pplnsMiners = 40;
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(3);
        expect(callArg(emailService.sendCapacityAlert, 2).level).toBe('recovery');
        expect(callArg(emailService.sendCapacityAlert, 2).scope).toBe('PPLNS main pool');
    });

    it('clearGroupAlertState deletes the per-group Redis key', async () => {
        const { service, redisStore } = createMonitor({});
        redisStore.set('pool:capacity-alert:group:abc', JSON.stringify({ level: 'warning', lastSentAt: Date.now() }));
        await service.clearGroupAlertState('abc');
        expect(redisStore.has('pool:capacity-alert:group:abc')).toBe(false);
    });

    it('uses custom warning + urgent thresholds from env', async () => {
        const { service, emailService } = createMonitor({
            pplnsMiners: 65, // below default 80 but above custom 60
            maxOutputs: MAX,
            warnThreshold: '0.6',
            urgentThreshold: '0.9',
        });
        await service.runChecks();
        expect(emailService.sendCapacityAlert).toHaveBeenCalledTimes(1);
        expect(callArg(emailService.sendCapacityAlert, 0).threshold).toBeCloseTo(0.6);
    });
});
