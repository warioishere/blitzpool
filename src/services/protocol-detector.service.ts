import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT } from '../providers/redis-client.provider';
import { ConfigService } from '@nestjs/config';
import { Server, Socket, createConnection } from 'net';

import { IProtocolHandler, ProtocolVersion, StratumPortConfig } from '../models/interfaces/unified-stratum.interfaces';
import { StratumV1Service } from './stratum-v1.service';
import { StratumV2Service } from './stratum-v2.service';
import { JobDeclarationService } from './job-declaration.service';

// Per-connection debug logs (TCP-connect, first-chunk hex, close-
// before-data, etc.) are gated on STRATUM_PROTOCOL_DEBUG. Default
// false — production logs stay clean. Set to "true" to enable
// verbose tracing during a debugging session.
const PROTOCOL_DEBUG = process.env.STRATUM_PROTOCOL_DEBUG?.trim().toLowerCase() === 'true';
function pdebug(msg: string): void {
  if (PROTOCOL_DEBUG) console.log(msg);
}

// Shared fail-ban state — Redis-backed, with in-memory fallback
let redisClient: any = null;
let banConfig = { maxFailures: 10, banDurationMs: 60 * 60 * 1000 };

// In-memory fallback (used if Redis unavailable) and fast-path cache for isConnectionBanned
const fallbackFailCounts = new Map<string, { count: number; resetAt: number }>();
const fallbackBannedIps = new Map<string, number>();
const banCache = new Map<string, number>(); // ip → expires timestamp (mirrors Redis for fast sync read)

const FAIL_KEY = (ip: string) => `failban:fail:${ip}`;
const BAN_KEY = (ip: string) => `failban:ban:${ip}`;

/**
 * Record a connection failure for an IP. Stored in Redis (with in-memory fallback).
 * Fire-and-forget — caller doesn't await.
 */
export function recordConnectionFailure(ip: string): void {
  if (!ip) return;

  if (redisClient) {
    // Redis path: INCR with TTL window
    (async () => {
      try {
        const count = await redisClient.incr(FAIL_KEY(ip));
        if (count === 1) {
          await redisClient.expire(FAIL_KEY(ip), 60);
        }
        if (count > banConfig.maxFailures) {
          const ttl = Math.ceil(banConfig.banDurationMs / 1000);
          await redisClient.setEx(BAN_KEY(ip), ttl, '1');
          await redisClient.del(FAIL_KEY(ip));
          banCache.set(ip, Date.now() + banConfig.banDurationMs);
          console.warn(`[FailBan] ${ip} banned for ${ttl / 60}min after ${count} failures`);
        }
      } catch (err) {
        console.error(`[FailBan] Redis error for ${ip}:`, (err as Error).message);
      }
    })();
    return;
  }

  // In-memory fallback
  const now = Date.now();
  let entry = fallbackFailCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    fallbackFailCounts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > banConfig.maxFailures) {
    const expiresAt = now + banConfig.banDurationMs;
    fallbackBannedIps.set(ip, expiresAt);
    banCache.set(ip, expiresAt);
    fallbackFailCounts.delete(ip);
    console.warn(`[FailBan] ${ip} banned for ${banConfig.banDurationMs / 60000}min after ${entry.count} failures (in-memory)`);
  }
}

/**
 * Check if an IP is banned. Sync — uses local cache that's refreshed by recordConnectionFailure
 * and by the periodic warmup. For exact ban removal, use Redis: DEL failban:ban:<ip>
 */
export function isConnectionBanned(ip: string): boolean {
  const expiresAt = banCache.get(ip);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    banCache.delete(ip);
    fallbackBannedIps.delete(ip);
    return false;
  }
  return true;
}

/** Internal: set the Redis client and start cache sync. Called from ProtocolDetectorService. */
export function _setBanRedisClient(client: any): void {
  redisClient = client;
}

/** Internal: configure ban thresholds. Called from ProtocolDetectorService. */
export function _setBanConfig(cfg: { maxFailures: number; banDurationMs: number }): void {
  banConfig = cfg;
}

/** Internal: refresh the local ban cache from Redis (called periodically). */
export async function _refreshBanCache(): Promise<void> {
  if (!redisClient) return;
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await redisClient.scan(cursor, { MATCH: 'failban:ban:*', COUNT: 1000 });
      cursor = result.cursor.toString();
      keys.push(...result.keys);
    } while (cursor !== '0');

    const seen = new Set<string>();
    for (const key of keys) {
      const ip = key.substring('failban:ban:'.length);
      seen.add(ip);
      const ttl = await redisClient.ttl(key);
      if (ttl > 0) {
        banCache.set(ip, Date.now() + ttl * 1000);
      }
    }
    // Drop cached entries that no longer exist in Redis (admin removed them)
    for (const ip of banCache.keys()) {
      if (!seen.has(ip)) banCache.delete(ip);
    }
  } catch (err) {
    console.error('[FailBan] cache refresh failed:', (err as Error).message);
  }
}

@Injectable()
export class ProtocolDetectorService implements OnModuleInit {

  constructor(
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientType | null,
    @Inject(forwardRef(() => StratumV1Service))
    private readonly stratumV1Service: StratumV1Service,
    @Inject(forwardRef(() => StratumV2Service))
    private readonly stratumV2Service: StratumV2Service,
    @Inject(forwardRef(() => JobDeclarationService))
    private readonly jobDeclarationService: JobDeclarationService,
  ) {
    // Configure shared ban settings from env
    _setBanConfig({
      maxFailures: parseInt(this.configService.get<string>('STRATUM_MAX_FAILURES_PER_MINUTE') ?? '10', 10),
      banDurationMs: parseInt(this.configService.get<string>('STRATUM_BAN_DURATION_MINUTES') ?? '60', 10) * 60 * 1000,
    });
  }

  async onModuleInit(): Promise<void> {
    // Wire up Redis for shared ban state across instances and admin-removable bans
    if (this.redisClient) {
      _setBanRedisClient(this.redisClient);
      await _refreshBanCache();
      console.log('[ProtocolDetector] Using Redis for fail-ban state');
    } else {
      console.log('[ProtocolDetector] Redis not available, using in-memory fail-ban');
    }

    this.startPorts();

    // Periodically refresh the local ban cache from Redis (picks up admin removals)
    setInterval(() => {
      _refreshBanCache().catch(() => {});
    }, 60 * 1000);
  }

  private startPorts(): void {
    const defaultPort = parseInt(
      this.configService.get<string>('STRATUM_PORT') ?? '3333',
      10,
    );
    const defaultDifficulty = parseFloat(
      this.configService.get<string>('STRATUM_START_DIFFICULTY') ?? '16384',
    );
    const defaultTargetShares = parseFloat(
      this.configService.get<string>('TARGET_SHARES_PER_MINUTE') ?? '6',
    );
    const highDiffPort = parseInt(
      this.configService.get<string>('STRATUM_HIGH_DIFF_PORT') ?? '3339',
      10,
    );
    const highDiffDifficulty = parseFloat(
      this.configService.get<string>('STRATUM_HIGH_DIFF_START_DIFFICULTY') ?? '1000000',
    );
    const highDiffTargetShares = parseFloat(
      this.configService.get<string>('STRATUM_HIGH_DIFF_TARGET_SHARES_PER_MINUTE') ?? defaultTargetShares.toString(),
    );

    const normalizedDefaultPort = Number.isNaN(defaultPort) ? 3333 : defaultPort;
    const normalizedDefaultDifficulty = Number.isNaN(defaultDifficulty) ? 16384 : defaultDifficulty;
    const normalizedDefaultTargetShares = Number.isNaN(defaultTargetShares) ? 6 : defaultTargetShares;

    this.startUnifiedServer({
      port: normalizedDefaultPort,
      initialDifficulty: normalizedDefaultDifficulty,
      allowSuggestedDifficulty: true,
      targetSharesPerMinute: normalizedDefaultTargetShares,
      payoutMode: 'solo',
    });

    if (!Number.isNaN(highDiffPort) && highDiffPort !== normalizedDefaultPort) {
      const normalizedHighDiffDifficulty = Number.isNaN(highDiffDifficulty) ? 1000000 : highDiffDifficulty;
      const normalizedHighDiffTargetShares = Number.isNaN(highDiffTargetShares)
        ? normalizedDefaultTargetShares
        : highDiffTargetShares;

      this.startUnifiedServer({
        port: highDiffPort,
        initialDifficulty: normalizedHighDiffDifficulty,
        allowSuggestedDifficulty: false,
        targetSharesPerMinute: normalizedHighDiffTargetShares,
        payoutMode: 'solo',
      });
    }

    // PPLNS port (optional)
    const pplnsPortStr = this.configService.get<string>('PPLNS_PORT');
    if (pplnsPortStr) {
      const pplnsPort = parseInt(pplnsPortStr, 10);
      if (!Number.isNaN(pplnsPort) && pplnsPort !== normalizedDefaultPort && pplnsPort !== highDiffPort) {
        const pplnsDifficulty = parseFloat(
          this.configService.get<string>('PPLNS_START_DIFFICULTY') ?? normalizedDefaultDifficulty.toString(),
        );
        const pplnsTargetShares = parseFloat(
          this.configService.get<string>('PPLNS_TARGET_SHARES_PER_MINUTE') ?? normalizedDefaultTargetShares.toString(),
        );

        // VarDiff floor for the PPLNS port. Default 500 — matches ~500 GH/s
        // devices at the default 6 shares/min target, which is the practical
        // lower bound for a miner that can meaningfully participate in the
        // PPLNS window without generating sub-dust ledger churn.
        const pplnsMinDiffRaw = parseFloat(
          this.configService.get<string>('PPLNS_MIN_DIFFICULTY') ?? '500',
        );
        const pplnsMinDifficulty = Number.isFinite(pplnsMinDiffRaw) && pplnsMinDiffRaw > 0
          ? pplnsMinDiffRaw
          : 500;

        // Share warmup gate for the PPLNS ledger. First N shares from a
        // fresh session are validated but not counted in the PPLNS window.
        // A CPU miner that briefly reaches the minimum diff by luck will
        // stall well before submitting N consecutive shares; a real
        // 500 GH/s+ miner churns through the gate in < 2 minutes.
        const pplnsWarmupRaw = parseInt(
          this.configService.get<string>('PPLNS_WARMUP_SHARES') ?? '10',
          10,
        );
        const pplnsWarmup = Number.isFinite(pplnsWarmupRaw) && pplnsWarmupRaw >= 0
          ? pplnsWarmupRaw
          : 10;

        const clampedInitialDiff = Math.max(
          Number.isNaN(pplnsDifficulty) ? normalizedDefaultDifficulty : pplnsDifficulty,
          pplnsMinDifficulty,
        );

        this.startUnifiedServer({
          port: Number.isNaN(pplnsPort) ? 3340 : pplnsPort,
          initialDifficulty: clampedInitialDiff,
          allowSuggestedDifficulty: true,
          targetSharesPerMinute: Number.isNaN(pplnsTargetShares) ? normalizedDefaultTargetShares : pplnsTargetShares,
          payoutMode: 'pplns',
          minimumDifficulty: pplnsMinDifficulty,
          ledgerWarmupShares: pplnsWarmup,
        });
        console.log(
          `[ProtocolDetector] PPLNS port ${pplnsPort} configured: `
          + `initialDiff=${clampedInitialDiff}, minDiff=${pplnsMinDifficulty}, `
          + `warmup=${pplnsWarmup} shares`,
        );

        // PPLNS HighDiff sibling port (auto-enabled alongside the regular
        // PPLNS port). Same `payoutMode: 'pplns'` so shares land in the
        // PPLNS window. Differs from the regular PPLNS port (3340) in two
        // ways that matter for rented hashrate:
        //   1. High starting difficulty (default 1M, vs. ~16k on 3340) —
        //      the first ~60s before pool-side VarDiff retargets aren't
        //      flooded with sub-min-diff shares.
        //   2. `allowSuggestedDifficulty: false` — rental endpoints
        //      (Braiins HashPower etc.) often send `mining.suggest_difficulty`
        //      with a low value on connect; on 3340 that'd be honored, on
        //      3349 it's ignored and the high initial diff stands until
        //      pool VarDiff adjusts.
        // Pool-side VarDiff (`checkDifficulty()` retarget every
        // DIFFICULTY_CHECK_INTERVAL_MS) is ACTIVE on this port — same as
        // every other port. After the first retarget cycle, this port's
        // session diff converges on what the actual hashrate demands.
        // Intended audience: rented hashrate (Braiins HashPower, MRR,
        // NiceHash) for PPLNS miners. Without this port, PPLNS users had
        // no PPLNS-credit-preserving rental target: pointing rentals at
        // 3339 routed shares to solo (no PPLNS credit, see bc1q...8n0
        // incident 2026-05-13); pointing them at 3340 worked correctness-
        // wise but the first minute of high-hashrate traffic produced
        // wasted shares under the start-low VarDiff cycle.
        const pplnsHighDiffPort = parseInt(
          this.configService.get<string>('PPLNS_HIGH_DIFF_PORT') ?? '3349',
          10,
        );
        if (
          !Number.isNaN(pplnsHighDiffPort)
          && pplnsHighDiffPort !== normalizedDefaultPort
          && pplnsHighDiffPort !== highDiffPort
          && pplnsHighDiffPort !== pplnsPort
        ) {
          // Reuse the existing STRATUM_HIGH_DIFF_* env vars for initial
          // difficulty and target shares — the "high diff" semantics are
          // the same as the solo HighDiff port, only the payout routing
          // differs. Warmup stays the PPLNS ledger value because warmup
          // is a PPLNS-ledger-gate concept, not a "high diff" concept.
          const pplnsHighDiffInitial = Math.max(
            Number.isNaN(highDiffDifficulty) ? 1000000 : highDiffDifficulty,
            pplnsMinDifficulty,
          );
          const pplnsHighDiffTargetShares = Number.isNaN(highDiffTargetShares)
            ? normalizedDefaultTargetShares
            : highDiffTargetShares;

          this.startUnifiedServer({
            port: pplnsHighDiffPort,
            initialDifficulty: pplnsHighDiffInitial,
            allowSuggestedDifficulty: false,
            targetSharesPerMinute: pplnsHighDiffTargetShares,
            payoutMode: 'pplns',
            minimumDifficulty: pplnsMinDifficulty,
            ledgerWarmupShares: pplnsWarmup,
          });
          console.log(
            `[ProtocolDetector] PPLNS HighDiff port ${pplnsHighDiffPort} configured: `
            + `initialDiff=${pplnsHighDiffInitial}, target=${pplnsHighDiffTargetShares}/min, `
            + `suggest_difficulty blocked, pool VarDiff active, `
            + `warmup=${pplnsWarmup} shares`,
          );
        }
      }
    }

    // Group-solo mining is not port-bound — membership is looked up per-address.
    // Any miner whose address is in an active group is automatically routed into
    // group-solo payout on whatever port they connect to (typically the solo port).
  }

  private startUnifiedServer(portConfig: StratumPortConfig): void {
    const server = new Server((socket: Socket) => {
      const ip = socket.remoteAddress ?? 'unknown';

      if (isConnectionBanned(ip)) {
        socket.destroy();
        return;
      }

      pdebug(`[ProtocolDetector] TCP connection from ${ip} on port ${portConfig.port}`);
      socket.setNoDelay(true);

      // Set a short timeout for protocol detection (30 seconds)
      // The handler will set the real timeout after detection
      socket.setTimeout(30000);

      const onTimeout = () => {
        pdebug(`[ProtocolDetector] No data received from ${socket.remoteAddress} on port ${portConfig.port}, closing`);
        socket.destroy();
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') {
          console.error(`[ProtocolDetector] Socket error from ${socket.remoteAddress} during detection:`, error.message);
        }
        socket.destroy();
      };

      const onClose = () => {
        pdebug(`[ProtocolDetector] Socket from ${socket.remoteAddress} closed before sending data`);
      };

      socket.on('timeout', onTimeout);
      socket.on('error', onError);
      socket.on('close', onClose);

      // Wait for first data to detect protocol
      socket.once('data', (firstChunk: Buffer) => {
        // Remove detection-phase listeners; handler will set its own
        socket.removeListener('timeout', onTimeout);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.setTimeout(0); // Clear detection timeout; handler sets real timeout

        pdebug(`[ProtocolDetector] First chunk from ${socket.remoteAddress}: ${firstChunk.length} bytes, hex=${firstChunk.toString('hex')}`);
        this.routeConnection(socket, firstChunk, portConfig);
      });
    });

    server.listen(portConfig.port, () => {
      console.log(
        `[ProtocolDetector] Unified Stratum server (V1 + V2) listening on port ${portConfig.port}`,
      );
    });
  }

  /**
   * Detect protocol from first byte and route to appropriate handler.
   *
   * HTTP: Starts with 'G' (0x47 = GET) or 'P' (0x50 = POST/PUT/PATCH)
   * SV1: Text-based JSON-RPC, always starts with '{' (0x7B)
   * SV2: Binary protocol with Noise encryption (non-JSON bytes)
   */
  private detectProtocol(firstByte: number): ProtocolVersion | 'http' | 'unknown' {
    // HTTP requests: GET (0x47), POST/PUT/PATCH (0x50)
    if (firstByte === 0x47 || firstByte === 0x50) {
      return 'http';
    }

    // SV1 always sends JSON: {"id":..., "method":"mining.subscribe", ...}
    // First byte will be '{' (0x7B) or occasionally whitespace before JSON
    if (firstByte === 0x7B) {
      // '{'
      return 'v1';
    }

    // Some V1 implementations may send whitespace or newline before JSON
    if (firstByte === 0x20 || firstByte === 0x0A || firstByte === 0x0D) {
      return 'v1';
    }

    // TLS ClientHello (0x16) — not a valid stratum protocol.
    // Reject early to avoid creating expensive StratumV2Client objects.
    if (firstByte === 0x16) {
      return 'unknown';
    }

    // SV2 binary protocol - Noise handshake starts with binary data.
    // Any non-JSON byte indicates SV2 binary protocol.
    return 'v2';
  }

  /**
   * Route a connection to the appropriate protocol handler.
   */
  private routeConnection(
    socket: Socket,
    firstChunk: Buffer,
    portConfig: StratumPortConfig,
  ): void {
    if (firstChunk.length === 0) {
      console.warn('[ProtocolDetector] Empty first chunk, closing connection');
      socket.destroy();
      return;
    }

    const firstByte = firstChunk[0];
    const protocol = this.detectProtocol(firstByte);

    switch (protocol) {
      case 'http':
        this.proxyToApi(socket, firstChunk);
        break;

      case 'v1':
        this.stratumV1Service.handleV1Connection(socket, firstChunk, portConfig);
        break;

      case 'v2':
        this.stratumV2Service.handleConnection(socket, firstChunk, portConfig);
        break;

      default:
        console.warn(
          `[ProtocolDetector] Unknown protocol (first byte: 0x${firstByte.toString(16).padStart(2, '0')}), closing`,
        );
        socket.destroy();
        break;
    }
  }

  /**
   * Proxy HTTP requests received on the mining port to the API port.
   * This allows JDC clients to POST downstream miner reports to the same
   * pool_address they already have configured, without needing the API port.
   */
  private proxyToApi(socket: Socket, firstChunk: Buffer): void {
    const apiPort = parseInt(this.configService.get<string>('API_PORT') ?? '3334', 10);
    console.log(`[ProtocolDetector] HTTP request detected, proxying to API port ${apiPort}`);

    const upstream = createConnection({ host: '127.0.0.1', port: apiPort }, () => {
      upstream.write(firstChunk);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.on('error', (err) => {
      console.error(`[ProtocolDetector] API proxy error: ${err.message}`);
      socket.destroy();
    });

    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }
}
