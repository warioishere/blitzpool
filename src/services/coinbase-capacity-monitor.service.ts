import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { PplnsService } from './pplns.service';
import { GroupService } from './group.service';
import { GroupSoloService } from './group-solo.service';
import { EmailService, CapacityAlertLevel } from './email.service';

/**
 * Coinbase capacity monitor.
 *
 * Every hour, compares the number of distinct miner addresses currently in
 * each payout-bucket's window against the maximum output count derivable
 * from the configured `PPLNS_COINBASE_WEIGHT_BUDGET`. When utilisation
 * crosses the configured warning (default 80 %) or urgent (default 95 %)
 * threshold, emails the operator. Dedups per-bucket in Redis so the same
 * state doesn't repeat-fire — at most one reminder per 24 h while the
 * condition persists, a single recovery mail when it clears.
 *
 * Buckets monitored:
 *   - PPLNS main pool (one alert stream)
 *   - each active payout group (one alert stream per group)
 *
 * The ceiling is read live from `PplnsService.getMaxCoinbaseOutputs()` so
 * changing `PPLNS_COINBASE_WEIGHT_BUDGET` and restarting the service is
 * enough — no capacity numbers are duplicated in env. Same budget is
 * reused for group-solo since the coinbase shape is identical.
 *
 * Disabled when `POOL_ADMIN_EMAIL` is empty or SMTP is not configured.
 */

const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_URGENT_THRESHOLD = 0.95;
const DAILY_REMINDER_MS = 24 * 60 * 60 * 1000;

const REDIS_KEY_PPLNS = 'pool:capacity-alert:pplns';
const REDIS_KEY_GROUP_PREFIX = 'pool:capacity-alert:group:';
// Redis state keys live forever (low cardinality; one per PPLNS + one per
// active group). No TTL needed — dissolveInternal clears per-group
// alerts via clearGroupAlertState().

type AlertLevel = 'below' | 'warning' | 'urgent';

interface AlertState {
    level: AlertLevel;
    lastSentAt: number;
}

@Injectable()
export class CoinbaseCapacityMonitorService implements OnModuleInit {

    private readonly logger = new Logger(CoinbaseCapacityMonitorService.name);
    private redis: any = null;
    private enabled = false;
    private adminEmail = '';
    private warningThreshold = DEFAULT_WARNING_THRESHOLD;
    private urgentThreshold = DEFAULT_URGENT_THRESHOLD;

    constructor(
        private readonly config: ConfigService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly pplnsService: PplnsService,
        private readonly groupService: GroupService,
        private readonly groupSoloService: GroupSoloService,
        private readonly emailService: EmailService,
    ) {}

    onModuleInit(): void {
        this.adminEmail = (this.config.get<string>('POOL_ADMIN_EMAIL') ?? '').trim();
        const envEnabled = (this.config.get<string>('POOL_CAPACITY_ALERT_ENABLED') ?? 'true').toLowerCase();

        this.warningThreshold = clamp(
            parseFloat(this.config.get<string>('POOL_CAPACITY_ALERT_THRESHOLD') ?? String(DEFAULT_WARNING_THRESHOLD)),
            0.01,
            0.99,
            DEFAULT_WARNING_THRESHOLD,
        );
        this.urgentThreshold = clamp(
            parseFloat(this.config.get<string>('POOL_CAPACITY_ALERT_URGENT_THRESHOLD') ?? String(DEFAULT_URGENT_THRESHOLD)),
            this.warningThreshold + 0.01,
            1.5,
            DEFAULT_URGENT_THRESHOLD,
        );

        if (!this.adminEmail) {
            this.logger.log('disabled — POOL_ADMIN_EMAIL is not set');
            this.enabled = false;
            return;
        }
        if (envEnabled === 'false' || envEnabled === '0') {
            this.logger.log('disabled — POOL_CAPACITY_ALERT_ENABLED=false');
            this.enabled = false;
            return;
        }
        this.enabled = true;
        this.logger.log(
            `enabled — to=${this.adminEmail}, warning=${(this.warningThreshold * 100).toFixed(0)}%, `
            + `urgent=${(this.urgentThreshold * 100).toFixed(0)}%`,
        );

        try {
            const store: any = this.cacheManager.store;
            if (store?.client) this.redis = store.client;
            else this.logger.warn('Redis not available — dedup skipped, will alert every cycle');
        } catch (err) {
            this.logger.warn(`Redis wiring failed: ${(err as Error).message}`);
        }
    }

    /** Hourly — scheduled via @Cron. Runs all buckets sequentially. */
    @Cron('0 0 * * * *')
    async checkHourly(): Promise<void> {
        if (!this.enabled) return;
        try {
            await this.checkPplns();
            await this.checkGroups();
        } catch (err) {
            this.logger.warn(`hourly check failed: ${(err as Error).message}`);
        }
    }

    /** Public entry point for tests + admin manual trigger. */
    async runChecks(): Promise<void> {
        if (!this.enabled) return;
        await this.checkPplns();
        await this.checkGroups();
    }

    /**
     * Clear the Redis alert state for a group. Called by GroupService
     * when a group is dissolved, so a later group with the same id
     * (unlikely) doesn't inherit stale "warning" state.
     */
    async clearGroupAlertState(groupId: string): Promise<void> {
        if (!this.redis) return;
        try {
            await this.redis.del(`${REDIS_KEY_GROUP_PREFIX}${groupId}`);
        } catch {
            // Non-fatal — stale key has no correctness impact.
        }
    }

    // ── PPLNS ──────────────────────────────────────────────────────

    private async checkPplns(): Promise<void> {
        if (!this.pplnsService.isEnabled()) return;
        const dist = await this.pplnsService.getCurrentDistribution();
        const current = dist.length;
        const max = this.pplnsService.getMaxCoinbaseOutputs();
        const percent = max > 0 ? current / max : 0;
        const { coinbaseWeightBudget } = this.pplnsService.getFeeConfig();

        await this.evaluateAndNotify({
            redisKey: REDIS_KEY_PPLNS,
            scope: 'PPLNS main pool',
            current,
            max,
            percent,
            coinbaseWeightBudget,
        });
    }

    // ── Groups ─────────────────────────────────────────────────────

    private async checkGroups(): Promise<void> {
        if (!this.groupSoloService.isEnabled()) return;
        const groups = await this.groupService.listGroups();
        const active = groups.filter(g => g.active);
        // Group-solo coinbase uses the same PPLNS weight budget, so the
        // per-block ceiling is the same count derivable from
        // PplnsService.getMaxCoinbaseOutputs(). If PPLNS is disabled we
        // still know the budget because the service reads it anyway.
        const max = this.pplnsService.getMaxCoinbaseOutputs();
        const { coinbaseWeightBudget } = this.pplnsService.getFeeConfig();
        for (const group of active) {
            try {
                const stats = await this.groupSoloService.getRoundStats(group.id);
                const current = stats.perAddress.length;
                const percent = max > 0 ? current / max : 0;
                await this.evaluateAndNotify({
                    redisKey: `${REDIS_KEY_GROUP_PREFIX}${group.id}`,
                    scope: `Group "${group.name}"`,
                    current,
                    max,
                    percent,
                    coinbaseWeightBudget,
                });
            } catch (err) {
                this.logger.warn(`group check failed for ${group.id}: ${(err as Error).message}`);
            }
        }
    }

    // ── State / decision logic ─────────────────────────────────────

    private async evaluateAndNotify(args: {
        redisKey: string;
        scope: string;
        current: number;
        max: number;
        percent: number;
        coinbaseWeightBudget: number;
    }): Promise<void> {
        const newLevel = this.levelFor(args.percent);
        const prev = await this.readState(args.redisKey);
        const decision = this.decide(prev, newLevel);

        if (decision.send === null) return;

        try {
            await this.emailService.sendCapacityAlert({
                to: this.adminEmail,
                level: decision.send,
                scope: args.scope,
                current: args.current,
                max: args.max,
                percent: args.percent,
                threshold: newLevel === 'urgent' ? this.urgentThreshold : this.warningThreshold,
                coinbaseWeightBudget: args.coinbaseWeightBudget,
                envVarName: 'PPLNS_COINBASE_WEIGHT_BUDGET',
            });
            this.logger.log(
                `${args.scope}: ${(args.percent * 100).toFixed(1)}% (${args.current}/${args.max}) `
                + `— sent ${decision.send} mail to ${this.adminEmail}`,
            );
        } catch (err) {
            this.logger.warn(`sendCapacityAlert failed for ${args.scope}: ${(err as Error).message}`);
            return;
        }

        await this.writeState(args.redisKey, { level: newLevel, lastSentAt: Date.now() });
    }

    private levelFor(percent: number): AlertLevel {
        if (percent >= this.urgentThreshold) return 'urgent';
        if (percent >= this.warningThreshold) return 'warning';
        return 'below';
    }

    /**
     * Transition rules:
     *   - Any upward step (below→warning, below→urgent, warning→urgent) → send.
     *   - Downward to 'below' → send 'recovery' once (warning→below, urgent→below).
     *   - Downward urgent→warning → silent; wait for either re-escalation or
     *     full recovery to 'below'. Avoids the noise of meaningless flip-flop.
     *   - Same level held ≥ 24 h and level is not 'below' → send a reminder.
     *   - Same level, less than 24 h → silent.
     *   - Same level = 'below' → silent always (recovery already delivered).
     */
    private decide(prev: AlertState, newLevel: AlertLevel): { send: CapacityAlertLevel | null } {
        const now = Date.now();
        if (prev.level === newLevel) {
            if (newLevel === 'below') return { send: null };
            // Same warning/urgent held — reminder once a day.
            if (now - prev.lastSentAt >= DAILY_REMINDER_MS) {
                return { send: newLevel };
            }
            return { send: null };
        }
        // Transitioned.
        if (newLevel === 'below') {
            // Previous was warning or urgent → recovery mail.
            return { send: 'recovery' };
        }
        if (newLevel === 'urgent') {
            // Anything → urgent is an escalation, always send.
            return { send: 'urgent' };
        }
        // newLevel === 'warning'
        if (prev.level === 'urgent') {
            // Stepping down from urgent to warning — don't spam. Wait for
            // either re-escalation or full recovery.
            return { send: null };
        }
        // prev === 'below', newLevel === 'warning' → first warning crossing.
        return { send: 'warning' };
    }

    private async readState(key: string): Promise<AlertState> {
        if (!this.redis) return { level: 'below', lastSentAt: 0 };
        try {
            const raw = await this.redis.get(key);
            if (!raw) return { level: 'below', lastSentAt: 0 };
            const parsed = JSON.parse(raw);
            if (parsed.level !== 'below' && parsed.level !== 'warning' && parsed.level !== 'urgent') {
                return { level: 'below', lastSentAt: 0 };
            }
            return { level: parsed.level, lastSentAt: Number(parsed.lastSentAt) || 0 };
        } catch {
            return { level: 'below', lastSentAt: 0 };
        }
    }

    private async writeState(key: string, state: AlertState): Promise<void> {
        if (!this.redis) return;
        try {
            await this.redis.set(key, JSON.stringify(state));
        } catch (err) {
            this.logger.warn(`state write failed for ${key}: ${(err as Error).message}`);
        }
    }
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
    if (!Number.isFinite(v)) return fallback;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}
