import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket, createConnection } from 'net';

import { IProtocolHandler, ProtocolVersion, StratumPortConfig } from '../models/interfaces/unified-stratum.interfaces';
import { StratumV1Service } from './stratum-v1.service';
import { StratumV2Service } from './stratum-v2.service';
import { JobDeclarationService } from './job-declaration.service';

// Shared fail-ban state (static, accessible without DI)
const failCounts = new Map<string, { count: number; resetAt: number }>();
const bannedIps = new Map<string, number>(); // ip → ban expires timestamp
let banConfig = { maxFailures: 5, banDurationMs: 60 * 60 * 1000 };

/**
 * Record a connection failure for an IP (invalid address, auth failure, etc.)
 * After exceeding threshold, the IP is banned.
 * Call this from anywhere — no DI needed.
 */
export function recordConnectionFailure(ip: string): void {
  if (!ip) return;
  const now = Date.now();
  let entry = failCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    failCounts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > banConfig.maxFailures) {
    bannedIps.set(ip, now + banConfig.banDurationMs);
    failCounts.delete(ip);
    console.warn(`[FailBan] ${ip} banned for ${banConfig.banDurationMs / 60000}min after ${entry.count} failures`);
  }
}

export function isConnectionBanned(ip: string): boolean {
  const expiresAt = bannedIps.get(ip);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    bannedIps.delete(ip);
    return false;
  }
  return true;
}

@Injectable()
export class ProtocolDetectorService implements OnModuleInit {

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => StratumV1Service))
    private readonly stratumV1Service: StratumV1Service,
    @Inject(forwardRef(() => StratumV2Service))
    private readonly stratumV2Service: StratumV2Service,
    @Inject(forwardRef(() => JobDeclarationService))
    private readonly jobDeclarationService: JobDeclarationService,
  ) {
    // Configure shared ban settings from env
    banConfig = {
      maxFailures: parseInt(this.configService.get<string>('STRATUM_MAX_FAILURES_PER_MINUTE') ?? '5', 10),
      banDurationMs: parseInt(this.configService.get<string>('STRATUM_BAN_DURATION_MINUTES') ?? '60', 10) * 60 * 1000,
    };
  }

  async onModuleInit(): Promise<void> {
    this.startPorts();

    // Periodically clean up expired entries (every 5 minutes)
    setInterval(() => {
      const now = Date.now();
      for (const [ip, expiresAt] of bannedIps) {
        if (now > expiresAt) bannedIps.delete(ip);
      }
      for (const [ip, entry] of failCounts) {
        if (now > entry.resetAt) failCounts.delete(ip);
      }
    }, 5 * 60 * 1000);
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
      });
    }
  }

  private startUnifiedServer(portConfig: StratumPortConfig): void {
    const server = new Server((socket: Socket) => {
      const ip = socket.remoteAddress ?? 'unknown';

      if (isConnectionBanned(ip)) {
        socket.destroy();
        return;
      }

      console.log(`[ProtocolDetector] TCP connection from ${ip} on port ${portConfig.port}`);
      socket.setNoDelay(true);

      // Set a short timeout for protocol detection (30 seconds)
      // The handler will set the real timeout after detection
      socket.setTimeout(30000);

      const onTimeout = () => {
        console.warn(`[ProtocolDetector] No data received from ${socket.remoteAddress} on port ${portConfig.port}, closing`);
        socket.destroy();
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') {
          console.error(`[ProtocolDetector] Socket error from ${socket.remoteAddress} during detection:`, error.message);
        }
        socket.destroy();
      };

      const onClose = () => {
        console.warn(`[ProtocolDetector] Socket from ${socket.remoteAddress} closed before sending data`);
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

        console.log(`[ProtocolDetector] First chunk from ${socket.remoteAddress}: ${firstChunk.length} bytes, hex=${firstChunk.toString('hex')}`);
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
    // Note: 0x09 (tab) is intentionally excluded — BraiinsOS sends a cipher
    // negotiation message starting with 0x09 that must route to V2.
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
