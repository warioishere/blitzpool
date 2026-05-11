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
import { Sv2NoiseConfig } from '../models/sv2/sv2-noise';
import { SV2_EXTENSION_TYPE_COINBASE_OUTPUT_WEIGHTS } from '../models/sv2/sv2-constants';
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

@Injectable()
export class JobDeclarationService implements OnModuleInit, JobDeclarationServiceRef {
  private readonly clients = new Map<string, JobDeclarationClient>();
  private readonly declaredJobs = new Map<string, { job: Sv2DeclareMiningJob; token: Buffer; clientId: string }>();
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
   * Resolve the pool's coinbase payout for a JDP token.
   *
   * Base JDP (no extensions negotiated) follows §6.4.3: a single TxOut
   * paying the miner directly. This matches the reference jd-server
   * and SRI JDC behaviour and is the spec-compliant default.
   *
   * When the JDC has negotiated ext 0x0003 (Coinbase Output Weights),
   * the JDS MAY return a multi-output coinbase plus a per-output
   * weights vector. The JDC then allocates `floor(T * weight_i / S)`
   * sats per output (§2). This is how PPLNS / Group-Solo distribute
   * payouts via JDP without custody hand-off.
   *
   * Failure modes (mode-detect error, distribution fetch error) fall
   * back to single-output paying the miner — a transient Redis/PG
   * blip never breaks JDP block production.
   */
  async resolveCoinbasePayout(
    minerAddress: string,
    negotiatedExtensions: ReadonlySet<number>,
  ): Promise<Sv2PoolPayout> {
    // Base spec only — JDC didn't negotiate weights. Spec MUST: stay
    // single-output. No need to even hit MiningModeService.
    if (!negotiatedExtensions.has(SV2_EXTENSION_TYPE_COINBASE_OUTPUT_WEIGHTS)) {
      return { addresses: [minerAddress], weights: null };
    }

    let mode: 'solo' | 'pplns' | 'group-solo' = 'solo';
    let groupId: string | undefined;
    try {
      const m = await this.miningModeService.getMode(minerAddress);
      mode = m.mode;
      groupId = m.groupId;
    } catch (err) {
      console.warn(`[JobDeclaration] Mode resolution failed for ${minerAddress}, falling back to solo: ${(err as Error).message}`);
    }

    if (mode === 'pplns' && this.pplnsService.isEnabled()) {
      try {
        const reward = this.getBlockRewardSats();
        const dist = await this.pplnsService.getPayoutDistribution(reward);
        if (dist.length > 0) {
          return {
            addresses: dist.map((d) => d.address),
            // Spec §2: amount_i ∝ weight_i / S. Using the sats array
            // directly makes amount_i = sats_i exactly (S = T when JDC
            // adds no own outputs); when JDC adds J > 0 sats of its
            // own, every miner is scaled by (T-J)/T — the same dilution
            // policy the base spec already permits.
            weights: dist.map((d) => Math.max(1, Math.floor(d.sats))),
          };
        }
      } catch (err) {
        console.warn(`[JobDeclaration] PPLNS distribution fetch failed, falling back to solo: ${(err as Error).message}`);
      }
    }

    if (mode === 'group-solo' && groupId && this.groupSoloService.isEnabled()) {
      try {
        const reward = this.getBlockRewardSats();
        // Pass minerAddress as finder — the JDP miner IS the block
        // finder by construction (they own the token, they declare
        // the job, they push the solution). Group-Solo emits an
        // additional finder-bonus output keyed to that address,
        // which the JDC will fund via the weights TLV like any other
        // pool output.
        const dist = await this.groupSoloService.getPayoutDistribution(groupId, reward, minerAddress);
        if (dist.length > 0) {
          return {
            addresses: dist.map((d) => d.address),
            weights: dist.map((d) => Math.max(1, Math.floor(d.sats))),
          };
        }
      } catch (err) {
        console.warn(`[JobDeclaration] Group-Solo distribution fetch failed, falling back to solo: ${(err as Error).message}`);
      }
    }

    // Solo (or fallback): single output to the miner. weights=null
    // means the client won't emit a TLV — implicit [1,0,…,0] applies.
    return { addresses: [minerAddress], weights: null };
  }

  /**
   * Encode an ordered list of pay-to-script addresses as a Bitcoin
   * consensus Vec<TxOut>. All outputs carry value=0 (spec 6.4.3 — the
   * JDC fills in real sats per the implicit single-output rule or the
   * ext-0x0003 weighted rule, depending on negotiation).
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
