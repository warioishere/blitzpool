// ── Job Declaration Service ────────────────────────────────────────
// NestJS service managing JDP connections. Acts as a Job Declarator
// Server (JDS), accepting custom block templates from miners.

import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import * as bitcoinjs from 'bitcoinjs-lib';

import {
  JobDeclarationClient,
  JobDeclarationServiceRef,
  Sv2PoolPayout,
} from '../models/JobDeclarationClient';
import { Sv2DeclareMiningJob } from '../models/sv2/sv2-jdp-messages';
import {
  Sv2RequestCoinbaseOutputs,
  Sv2RequestCoinbaseOutputsSuccess,
  Sv2RequestCoinbaseOutputsError,
} from '../models/sv2/sv2-extensions-messages';
import { Sv2NoiseConfig } from '../models/sv2/sv2-noise';
import { SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS } from '../models/sv2/sv2-constants';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { StratumV2Service } from './stratum-v2.service';
import { TemplateDistributionService } from './template-distribution.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { NotificationService } from './notification.service';
import { MiningModeService } from './mining-mode.service';
import { PplnsService } from './pplns.service';
import { GroupSoloService } from './group-solo.service';
import { normalizeIp } from '../utils/network.utils';

// Fallback block-reward (post-2024 halving subsidy) when no template is
// available — used only at cold start, before TDP has delivered the
// first NewTemplate. Real value flows from latestTemplate.coinbasevalue.
const FALLBACK_BLOCK_REWARD_SATS = 312_500_000;

// Multiplier on the latest template's coinbasevalue beyond which a
// `RequestCoinbaseOutputs.pool_revenue` is treated as implausible.
// Real templates rarely move > 50 % from one to the next; 1.5x leaves
// headroom for legitimate fee spikes while catching obvious abuse.
const POOL_REVENUE_PLAUSIBILITY_MULTIPLIER = 1.5;

// Bitcoin's standard dust threshold for P2WPKH outputs (~ 294 sats);
// outputs computed below this go into the pool's pending ledger
// instead of an on-chain output. Pool's own ledger handles the
// accumulation off-band.
const DUST_THRESHOLD_SATS = 294;

interface EmittedCoinbaseResponse {
  requestId: number;
  prevHash: Buffer;       // template binding
  outputs: Buffer;        // consensus-serialized Vec<TxOut>
  emittedAt: number;      // epoch-ms
}

@Injectable()
export class JobDeclarationService implements OnModuleInit, JobDeclarationServiceRef {
  private readonly clients = new Map<string, JobDeclarationClient>();
  private readonly declaredJobs = new Map<string, { job: Sv2DeclareMiningJob; token: Buffer; clientId: string }>();

  // Validation cache for ext 0x0003 (Dynamic Coinbase Outputs).
  // Keyed by tokenHex, holds a short list of responses we've emitted
  // for that token. Each entry binds to a prev_hash; when the pool
  // observes a new prev_hash internally the old entries are evicted
  // (template-bound TTL, see evictStaleEmittedResponses()).
  private readonly emittedResponses = new Map<string, EmittedCoinbaseResponse[]>();

  // Pool's current prev_hash view (updated from TDP). Used to detect
  // template changes for cache invalidation.
  private lastObservedPrevHash: Buffer | null = null;

  private server: Server | null = null;
  private jdpPort: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    @Inject(forwardRef(() => StratumV2Service))
    private readonly stratumV2Service: StratumV2Service,
    private readonly templateDistributionService: TemplateDistributionService,
    private readonly blocksService: BlocksService,
    @Inject(forwardRef(() => NotificationService))
    private readonly notificationService: NotificationService,
    private readonly miningModeService: MiningModeService,
    private readonly pplnsService: PplnsService,
    private readonly groupSoloService: GroupSoloService,
  ) {
    this.jdpPort = parseInt(this.configService.get('SV2_JDP_PORT') ?? '3337', 10);
    if (isNaN(this.jdpPort)) this.jdpPort = 3337;
  }

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get('SV2_JDP_ENABLED')?.toLowerCase();
    if (enabled !== 'true') {
      console.log('[JobDeclaration] JDP disabled (set SV2_JDP_ENABLED=true to enable)');
      return;
    }

    // Delay startup to let other services initialize
    setTimeout(() => {
      this.startJdpServer();
    }, 1000 * 12);
  }

  private startJdpServer(): void {
    this.server = new Server((socket: Socket) => {
      socket.setNoDelay(true);
      socket.setTimeout(30000);

      const onTimeout = () => {
        console.warn(`[JobDeclaration] No data received on JDP port ${this.jdpPort}, closing`);
        socket.destroy();
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') {
          console.error('[JobDeclaration] Socket error during detection:', error.message);
        }
        socket.destroy();
      };

      socket.on('timeout', onTimeout);
      socket.on('error', onError);

      socket.once('data', (firstChunk: Buffer) => {
        socket.removeListener('timeout', onTimeout);
        socket.removeListener('error', onError);
        socket.setTimeout(0);

        this.handleConnection(socket, firstChunk);
      });
    });

    this.server.listen(this.jdpPort, () => {
      console.log(`[JobDeclaration] JDP server listening on port ${this.jdpPort}`);
    });
  }

  handleConnection(socket: Socket, firstChunk: Buffer): void {
    const client = new JobDeclarationClient(socket, firstChunk, this);

    this.clients.set(client.clientId, client);

    socket.on('close', () => {
      this.clients.delete(client.clientId);
    });
  }

  getNoiseConfig(): Sv2NoiseConfig {
    return this.stratumV2Service.getNoiseConfig();
  }

  async validateTransactions(txHashes: string[]): Promise<{ known: string[]; unknown: string[] }> {
    try {
      // JDP DeclareMiningJob sends wtxids, so we must match against mempool wtxids
      const mempoolWtxids = await this.bitcoinRpcService.getRawMempoolWtxids();

      const known: string[] = [];
      const unknown: string[] = [];

      for (const hash of txHashes) {
        if (mempoolWtxids.has(hash)) {
          known.push(hash);
        } else {
          unknown.push(hash);
        }
      }

      return { known, unknown };
    } catch (err) {
      console.error('[JobDeclaration] Failed to validate transactions:', (err as Error).message);
      // If we can't validate, accept all to avoid blocking miners
      return { known: txHashes, unknown: [] };
    }
  }

  /**
   * Find the miner's BTC address from their mining connection (by IP).
   * The JD client connects to both the mining port and JDP port from the same IP.
   * Normalizes IPv6-mapped IPv4 addresses for matching.
   */
  getMinerAddressByIp(remoteIp: string): string | null {
    const normalizedRemoteIp = normalizeIp(remoteIp);
    const allClients = this.stratumV2Service.getAllClients();

    for (const client of allClients) {
      const clientIp = normalizeIp(client.getRemoteAddress());
      if (clientIp === normalizedRemoteIp) {
        const addr = client.getAddress();
        if (addr) return addr;
      }
    }
    return null;
  }

  /**
   * Get full miner info (address, worker, sessionId) from the mining connection by IP.
   * Used by JDP PushSolution to populate the Found Block list consistently
   * with SV1/SV2 standard/extended channel blocks.
   */
  getMinerInfoByIp(remoteIp: string): { address: string; worker: string; sessionId: string } | null {
    const normalizedRemoteIp = normalizeIp(remoteIp);
    const allClients = this.stratumV2Service.getAllClients();

    for (const client of allClients) {
      const clientIp = normalizeIp(client.getRemoteAddress());
      if (clientIp === normalizedRemoteIp) {
        const addr = client.getAddress();
        if (addr) {
          return {
            address: addr,
            worker: client.getWorkerName(),
            sessionId: client.sessionId,
          };
        }
      }
    }
    return null;
  }

  getBlockHeight(): number {
    return this.bitcoinRpcService.getBlockHeight();
  }

  /**
   * Get the current template's prevHash for PushSolution matching (spec 6.4.9).
   */
  getCurrentPrevHash(): Buffer | null {
    const template = this.templateDistributionService.getLatestTemplate();
    if (!template) return null;
    return template.prevHash.prevHash;
  }

  /**
   * Resolve the pool's coinbase payout for `AllocateMiningJobToken.Success`.
   *
   * The Success message carries the §6.4.3 single-output fallback regardless
   * of whether ext 0x0003 (Dynamic Coinbase Outputs) is negotiated. Vanilla
   * JDCs that haven't negotiated 0x0003 use these outputs directly per §6.4.3.
   * 0x0003-aware JDCs treat them as the spec-§3.4 fallback distribution to
   * fall back to if a per-job `RequestCoinbaseOutputs` cannot be served.
   *
   * `negotiatedExtensions` is currently unused — the AllocateMiningJobToken.Success
   * payload doesn't carry any extension-conditional TLVs since the old static
   * coinbase_tx_output_weights TLV was removed in favor of the per-job request
   * flow. Kept in the signature so the interface stays stable for future
   * extensions that might layer TLVs back onto the Success message.
   */
  async resolveCoinbasePayout(
    minerAddress: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    negotiatedExtensions: ReadonlySet<number>,
  ): Promise<Sv2PoolPayout> {
    return { addresses: [minerAddress], weights: null };
  }

  /**
   * Handle ext 0x0003 `RequestCoinbaseOutputs` (JDC → JDS).
   *
   * Computes the pool's multi-output distribution from current state (PPLNS
   * window, Group-Solo state, or solo fallback) using the JDC-reported
   * `pool_revenue` to size amounts, applies the pool's dust-pending policy,
   * encodes as a Bitcoin-consensus `Vec<TxOut>`, and caches the response
   * keyed by `(token, request_id)` so a later `DeclareMiningJob` can be
   * validated against it.
   *
   * Returns `{ kind: 'success' }` with the serialized outputs ready to be
   * written into a Success frame, or `{ kind: 'error' }` with a spec-§2.3
   * error code.
   */
  async handleRequestCoinbaseOutputs(
    req: Sv2RequestCoinbaseOutputs,
    minerAddress: string,
  ): Promise<
    | { kind: 'success'; success: Sv2RequestCoinbaseOutputsSuccess }
    | { kind: 'error'; error: Sv2RequestCoinbaseOutputsError }
  > {
    // 1. prev_hash plausibility. The pool's view advances strictly
    //    monotonically (new block found → new prev_hash); if the JDC's
    //    template references a prev_hash we no longer consider current,
    //    we refuse rather than emit outputs for an obsolete payout window.
    const currentPrevHash = this.getCurrentPrevHash();
    if (currentPrevHash && !currentPrevHash.equals(req.prevHash)) {
      // Evict old cache entries opportunistically while we're here.
      this.observePrevHash(currentPrevHash);
      return {
        kind: 'error',
        error: { requestId: req.requestId, errorCode: 'stale-prev-hash' },
      };
    }

    // Refresh template-bound cache binding if needed.
    if (currentPrevHash) {
      this.observePrevHash(currentPrevHash);
    }

    // 2. Revenue plausibility — clamp against current template + multiplier.
    const latestCoinbaseValue = this.getBlockRewardSats();
    const maxPlausible = Math.floor(latestCoinbaseValue * POOL_REVENUE_PLAUSIBILITY_MULTIPLIER);
    if (req.poolRevenue > BigInt(maxPlausible)) {
      return {
        kind: 'error',
        error: { requestId: req.requestId, errorCode: 'revenue-too-large' },
      };
    }

    // 3. Compute the distribution from current PPLNS / Group-Solo / solo state.
    let outputs: Array<{ address: string; sats: number }>;
    try {
      outputs = await this.computeDynamicOutputs(minerAddress, Number(req.poolRevenue));
    } catch (err) {
      console.warn(
        `[JobDeclaration] computeDynamicOutputs failed for ${minerAddress}, returning internal error: ${(err as Error).message}`,
      );
      return {
        kind: 'error',
        error: { requestId: req.requestId, errorCode: 'internal' },
      };
    }

    // 4. Encode as consensus-serialized Vec<TxOut>.
    const coinbaseTxOutputs = this.encodeDynamicCoinbaseOutputs(outputs);

    // 5. Cache for later validation.
    const tokenHex = req.miningJobToken.toString('hex');
    const cache = this.emittedResponses.get(tokenHex) ?? [];
    cache.push({
      requestId: req.requestId,
      prevHash: Buffer.from(req.prevHash),
      outputs: coinbaseTxOutputs,
      emittedAt: Date.now(),
    });
    this.emittedResponses.set(tokenHex, cache);

    return {
      kind: 'success',
      success: { requestId: req.requestId, coinbaseTxOutputs },
    };
  }

  /**
   * Compute the dynamic coinbase output list for a miner at a given
   * `pool_revenue`, applying:
   *   - mode detection (solo / pplns / group-solo)
   *   - the matching pool service's payout distribution
   *   - dust suppression (sub-294-sat outputs go to pending, not on chain)
   *   - solo fallback on any transient error
   *
   * Returns the list of `{ address, sats }` pairs the coinbase should carry.
   * The list is NEVER empty — at minimum the miner gets a single output for
   * the full revenue (solo behaviour).
   */
  private async computeDynamicOutputs(
    minerAddress: string,
    poolRevenue: number,
  ): Promise<Array<{ address: string; sats: number }>> {
    const soloFallback = [{ address: minerAddress, sats: poolRevenue }];

    let mode: 'solo' | 'pplns' | 'group-solo' = 'solo';
    let groupId: string | undefined;
    try {
      const m = await this.miningModeService.getMode(minerAddress);
      mode = m.mode;
      groupId = m.groupId;
    } catch (err) {
      console.warn(
        `[JobDeclaration] Mode resolution failed for ${minerAddress}, using solo: ${(err as Error).message}`,
      );
      return soloFallback;
    }

    if (mode === 'pplns' && this.pplnsService.isEnabled()) {
      try {
        const dist = await this.pplnsService.getPayoutDistribution(poolRevenue);
        const filtered = this.applyDustPolicy(dist);
        if (filtered.length > 0) return filtered;
      } catch (err) {
        console.warn(
          `[JobDeclaration] PPLNS distribution fetch failed: ${(err as Error).message}`,
        );
      }
    }

    if (mode === 'group-solo' && groupId && this.groupSoloService.isEnabled()) {
      try {
        // The JDP miner IS the block-finder by construction (their token,
        // their declared job, their pushed solution) — pass them as the
        // finderAddress so the Group-Solo finder bonus lands in the coinbase.
        const dist = await this.groupSoloService.getPayoutDistribution(
          groupId,
          poolRevenue,
          minerAddress,
        );
        const filtered = this.applyDustPolicy(dist);
        if (filtered.length > 0) return filtered;
      } catch (err) {
        console.warn(
          `[JobDeclaration] Group-Solo distribution fetch failed: ${(err as Error).message}`,
        );
      }
    }

    return soloFallback;
  }

  /**
   * Drop sub-dust outputs from a distribution. Amounts below the dust
   * threshold accumulate in the pool's internal pending ledger and pay
   * out in a later block when the per-miner balance crosses the threshold.
   * The dropped sats are NOT redistributed across the remaining outputs —
   * they stay in pending, which means `sum(emitted) ≤ pool_revenue` (spec
   * §2.2). The JDC will see a slightly under-allocated coinbase, which is
   * allowed under §6.4.3 ("Pool MAY pay proportionally smaller rewards").
   */
  private applyDustPolicy(
    dist: ReadonlyArray<{ address: string; sats: number }>,
  ): Array<{ address: string; sats: number }> {
    const out: Array<{ address: string; sats: number }> = [];
    for (const d of dist) {
      const sats = Math.floor(d.sats);
      if (sats >= DUST_THRESHOLD_SATS) {
        out.push({ address: d.address, sats });
      }
    }
    return out;
  }

  /**
   * Look up the previously-emitted `RequestCoinbaseOutputs.Success`
   * response for this `(token, prev_hash)`, returning the serialized
   * outputs buffer if one matches. Used during `DeclareMiningJob`
   * validation to reject coinbases that don't match any emitted response.
   *
   * Returns the buffer if a cached emission exists; null otherwise. The
   * caller is responsible for the multiset-match check (the cached buffer
   * is the consensus-serialized output list).
   */
  findEmittedOutputsForJob(token: Buffer, prevHash: Buffer): Buffer | null {
    const cache = this.emittedResponses.get(token.toString('hex'));
    if (!cache || cache.length === 0) return null;
    for (let i = cache.length - 1; i >= 0; i--) {
      if (cache[i].prevHash.equals(prevHash)) {
        return cache[i].outputs;
      }
    }
    return null;
  }

  /**
   * Note the pool's current prev_hash. If it differs from the previously
   * observed one, all cached responses bound to the old prev_hash are
   * dropped — they reference a payout window that's no longer "current"
   * from the pool's perspective.
   */
  observePrevHash(prevHash: Buffer): void {
    if (this.lastObservedPrevHash && this.lastObservedPrevHash.equals(prevHash)) {
      return; // unchanged
    }
    this.lastObservedPrevHash = Buffer.from(prevHash);
    // Evict stale entries from every token's cache list.
    for (const [tokenHex, list] of this.emittedResponses.entries()) {
      const fresh = list.filter((e) => e.prevHash.equals(prevHash));
      if (fresh.length === 0) {
        this.emittedResponses.delete(tokenHex);
      } else if (fresh.length !== list.length) {
        this.emittedResponses.set(tokenHex, fresh);
      }
    }
  }

  /** Test-only: number of cache entries currently retained for a token. */
  __emittedResponsesCountForToken(tokenHex: string): number {
    return this.emittedResponses.get(tokenHex)?.length ?? 0;
  }

  /**
   * Encode an ordered list of pay-to-script addresses as a Bitcoin
   * consensus Vec<TxOut>. All outputs carry value=0 — used for the
   * §6.4.3 single-output payload in AllocateMiningJobToken.Success
   * (vanilla JDP path; the JDC fills in the real reward at coinbase
   * construction).
   *
   * The dynamic-outputs flow (ext 0x0003 §2) uses encodeDynamicCoinbaseOutputs
   * instead, which carries real sats values.
   *
   * Public so JobDeclarationClient can produce the buffer for token
   * caches and so tests can exercise the encoder in isolation.
   */
  encodeCoinbaseOutputs(addresses: string[]): Buffer {
    const network = this.resolveNetwork();
    if (addresses.length === 0) {
      return Buffer.from([0x00]);
    }

    const parts: Buffer[] = [];

    // VarInt: output count
    if (addresses.length < 0xfd) {
      parts.push(Buffer.from([addresses.length]));
    } else if (addresses.length <= 0xffff) {
      const lenBuf = Buffer.alloc(3);
      lenBuf[0] = 0xfd;
      lenBuf.writeUInt16LE(addresses.length, 1);
      parts.push(lenBuf);
    } else {
      const lenBuf = Buffer.alloc(5);
      lenBuf[0] = 0xfe;
      lenBuf.writeUInt32LE(addresses.length, 1);
      parts.push(lenBuf);
    }

    for (const addr of addresses) {
      const scriptPubKey = bitcoinjs.address.toOutputScript(addr, network);

      // value: u64 LE, always 0 — JDC fills in real reward.
      parts.push(Buffer.alloc(8, 0));

      // script length (VarInt) + script bytes
      if (scriptPubKey.length < 0xfd) {
        parts.push(Buffer.from([scriptPubKey.length]));
      } else {
        const lenBuf = Buffer.alloc(3);
        lenBuf[0] = 0xfd;
        lenBuf.writeUInt16LE(scriptPubKey.length, 1);
        parts.push(lenBuf);
      }
      parts.push(scriptPubKey);
    }

    return Buffer.concat(parts);
  }

  /**
   * Encode an ordered list of `{ address, sats }` pairs as a Bitcoin
   * consensus `Vec<TxOut>`. Used in the ext 0x0003 `RequestCoinbaseOutputs.Success`
   * payload where the JDS commits to exact per-output amounts.
   *
   * Each output: u64 value LE + VarInt script_len + scriptPubKey bytes.
   * Output count is VarInt-encoded.
   */
  encodeDynamicCoinbaseOutputs(outputs: ReadonlyArray<{ address: string; sats: number }>): Buffer {
    const network = this.resolveNetwork();
    if (outputs.length === 0) {
      return Buffer.from([0x00]);
    }

    const parts: Buffer[] = [];

    // VarInt: output count
    if (outputs.length < 0xfd) {
      parts.push(Buffer.from([outputs.length]));
    } else if (outputs.length <= 0xffff) {
      const lenBuf = Buffer.alloc(3);
      lenBuf[0] = 0xfd;
      lenBuf.writeUInt16LE(outputs.length, 1);
      parts.push(lenBuf);
    } else {
      const lenBuf = Buffer.alloc(5);
      lenBuf[0] = 0xfe;
      lenBuf.writeUInt32LE(outputs.length, 1);
      parts.push(lenBuf);
    }

    for (const out of outputs) {
      const scriptPubKey = bitcoinjs.address.toOutputScript(out.address, network);

      // value: u64 LE
      const valueBuf = Buffer.alloc(8);
      valueBuf.writeBigUInt64LE(BigInt(Math.floor(out.sats)));
      parts.push(valueBuf);

      // script length (VarInt) + script bytes
      if (scriptPubKey.length < 0xfd) {
        parts.push(Buffer.from([scriptPubKey.length]));
      } else {
        const lenBuf = Buffer.alloc(3);
        lenBuf[0] = 0xfd;
        lenBuf.writeUInt16LE(scriptPubKey.length, 1);
        parts.push(lenBuf);
      }
      parts.push(scriptPubKey);
    }

    return Buffer.concat(parts);
  }

  private getBlockRewardSats(): number {
    const t = this.templateDistributionService.getLatestTemplate();
    const v = t?.jobTemplate?.blockData?.coinbasevalue;
    return Number.isFinite(v) && (v as number) > 0 ? (v as number) : FALLBACK_BLOCK_REWARD_SATS;
  }

  private resolveNetwork(): bitcoinjs.Network {
    const networkName = this.configService.get('NETWORK') ?? 'mainnet';
    return networkName === 'testnet'
      ? bitcoinjs.networks.testnet
      : networkName === 'regtest'
        ? bitcoinjs.networks.regtest
        : bitcoinjs.networks.bitcoin;
  }

  onJobDeclared(clientId: string, job: Sv2DeclareMiningJob, token: Buffer): void {
    console.log(`[JDP] ✅ DeclareMiningJob SUCCESS: client=${clientId}, version=0x${job.version.toString(16)}, coinbaseTxPrefixLen=${job.coinbaseTxPrefix.length}, wtxidCount=${job.wtxidList.length}, token=${token.toString('hex').substring(0, 16)}...`);

    // Store the declared job
    this.declaredJobs.set(token.toString('hex'), { job, token, clientId });

    // NOTE: No need to bridge the job to the mining channel here.
    // Per the SV2 spec, after receiving DeclareMiningJobSuccess, the JDC
    // sends SetCustomMiningJob to the pool on its mining connection itself.
    // Our pool handles that incoming SetCustomMiningJob in StratumV2Client.
  }

  getDeclaredJob(tokenHex: string): { job: Sv2DeclareMiningJob; token: Buffer; clientId: string } | undefined {
    return this.declaredJobs.get(tokenHex);
  }

  getClient(clientId: string): JobDeclarationClient | undefined {
    return this.clients.get(clientId);
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  getConfigValue(key: string): string | undefined {
    return this.configService.get(key);
  }

  /**
   * Get raw transaction data from the current template, keyed by wtxid hex.
   * Used by JobDeclarationClient to collect raw tx data for known transactions
   * during job declaration, enabling block reconstruction via PushSolution.
   */
  getTemplateTransactions(): Map<string, Buffer> {
    const templateData = this.templateDistributionService.getLatestTemplate();
    if (!templateData) return new Map();

    const txs = templateData.jobTemplate.block.transactions;
    if (!txs || txs.length <= 1) return new Map();

    const result = new Map<string, Buffer>();
    // Skip index 0 (coinbase) — only include non-coinbase transactions
    for (let i = 1; i < txs.length; i++) {
      try {
        const tx = txs[i];
        // getHash(true) = witness hash = wtxid (natural byte order)
        // Reverse to display format to match how we compare JDC wtxids
        const wtxid = Buffer.from(tx.getHash(true)).reverse().toString('hex');
        const rawTx = tx.toBuffer();
        result.set(wtxid, rawTx);
      } catch {
        // Skip transactions that can't be serialized
      }
    }

    return result;
  }

  /**
   * Fetch a raw transaction from Bitcoin Core by txid.
   * Returns the raw transaction buffer, or null if not found.
   */
  async getRawTransaction(txid: string): Promise<Buffer | null> {
    try {
      const rawHex = await this.bitcoinRpcService.getRawTransaction(txid);
      if (rawHex) {
        return Buffer.from(rawHex, 'hex');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Submit a serialized block to Bitcoin Core.
   * Called by JobDeclarationClient when PushSolution is received.
   */
  async submitBlock(blockHex: string): Promise<string> {
    return this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
  }

  async saveBlock(data: { height: number; minerAddress: string; worker: string; sessionId: string; blockData: string }): Promise<void> {
    await this.blocksService.save(data);
  }

  async notifyBlockFound(address: string, height: number, result: string): Promise<void> {
    await this.notificationService.notifySubscribersBlockFound(address, height, null, result);
  }
}
