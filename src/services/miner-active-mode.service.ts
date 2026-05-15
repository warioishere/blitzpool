import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { MiningMode } from './mining-mode.service';

/**
 * Per-address "currently-active mining mode" marker.
 *
 * Written in Redis by the stratum layer on every accepted share — after
 * the routing decision (pplns / group-solo / solo) has been made — with
 * a short TTL. Read by MiningModeService.getMode() so UI dashboards
 * reflect the port the miner is ACTUALLY connected to right now, rather
 * than the retrospective state (PPLNS window membership + group DB)
 * which lags by hours after a port switch.
 *
 * Why a separate key instead of a timestamp scan:
 *   - O(1) read + write; no sorted-set scan on the hot path
 *   - Single source of truth written exactly once per share by the
 *     component that already made the routing decision
 *   - Expires automatically when the miner stops — after 5 min of
 *     silence, the detection falls back to the existing state-based
 *     logic, which is the right thing for truly idle addresses
 *
 * TTL 5 min is the sweet spot: normal miners submit shares every
 * few seconds so the marker is continually refreshed; short config
 * pauses (seconds to 1-2 min) don't flip the mode; true inactivity
 * (>5 min) lets the fallback take over.
 */
@Injectable()
export class MinerActiveModeService implements OnModuleInit {

    private redis: any = null;
    private static readonly TTL_SECONDS = 5 * 60;
    /**
     * In-process debounce: skip the Redis write if the same mode was written
     * within REFRESH_INTERVAL_MS. TTL is 5 min, so refreshing once/min keeps
     * the marker fresh with a 4-min safety margin. A mode change always
     * writes regardless of the interval (port-switch detection is the whole
     * point of the marker).
     */
    private static readonly REFRESH_INTERVAL_MS = 60_000;
    private readonly lastMark = new Map<string, { mode: MiningMode; refreshedAt: number }>();

    constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

    onModuleInit(): void {
        try {
            const store: any = this.cacheManager.store;
            if (store?.client) {
                this.redis = store.client;
            }
        } catch {
            // Redis optional — falls keine Redis-Verbindung da, wird jeder mark/get ein no-op.
        }
    }

    private key(address: string): string {
        return `miner:${address}:mode`;
    }

    /**
     * Record that `address` just submitted an accepted share while routed
     * as `mode`. Fire-and-forget semantics; failure to write is logged
     * but never blocks the share path.
     */
    async mark(address: string, mode: MiningMode): Promise<void> {
        if (!this.redis || !address) return;

        const now = Date.now();
        const last = this.lastMark.get(address);
        if (last && last.mode === mode && now - last.refreshedAt < MinerActiveModeService.REFRESH_INTERVAL_MS) {
            return;
        }

        try {
            await this.redis.set(this.key(address), mode, { EX: MinerActiveModeService.TTL_SECONDS });
            this.lastMark.set(address, { mode, refreshedAt: now });
        } catch {
            try {
                await this.redis.set(this.key(address), mode);
                if (typeof this.redis.expire === 'function') {
                    await this.redis.expire(this.key(address), MinerActiveModeService.TTL_SECONDS);
                }
                this.lastMark.set(address, { mode, refreshedAt: now });
            } catch {
                // Swallow — not worth crashing a share submit over a marker write.
            }
        }
    }

    /**
     * Return the most recently marked mode for this address, or null
     * when the marker is absent or expired. Callers fall back to the
     * legacy state-based detection in that case.
     */
    async get(address: string): Promise<MiningMode | null> {
        if (!this.redis || !address) return null;
        try {
            const raw = await this.redis.get(this.key(address));
            if (raw === 'solo' || raw === 'pplns' || raw === 'group-solo') {
                return raw;
            }
            return null;
        } catch {
            return null;
        }
    }
}
