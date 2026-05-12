import { Injectable, Inject } from '@nestjs/common';
import type { RedisClientType } from 'redis';

import { MiningMode } from './mining-mode.service';
import { REDIS_CLIENT } from '../providers/redis-client.provider';

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
export class MinerActiveModeService {

    private static readonly TTL_SECONDS = 5 * 60;

    constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null) {}

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
        try {
            // node-redis-style options object. Falls Probleme: Fallback set + expire.
            await this.redis.set(this.key(address), mode, { EX: MinerActiveModeService.TTL_SECONDS });
        } catch {
            try {
                await this.redis.set(this.key(address), mode);
                if (typeof this.redis.expire === 'function') {
                    await this.redis.expire(this.key(address), MinerActiveModeService.TTL_SECONDS);
                }
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
