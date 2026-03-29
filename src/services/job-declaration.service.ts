// ── Job Declaration Service ────────────────────────────────────────
// NestJS service managing JDP connections. Acts as a Job Declarator
// Server (JDS), accepting custom block templates from miners.

import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import * as bitcoinjs from 'bitcoinjs-lib';

import { JobDeclarationClient, JobDeclarationServiceRef } from '../models/JobDeclarationClient';
import { Sv2DeclareMiningJob } from '../models/sv2/sv2-jdp-messages';
import { Sv2NoiseConfig } from '../models/sv2/sv2-noise';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { StratumV2Service } from './stratum-v2.service';
import { TemplateDistributionService } from './template-distribution.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { NotificationService } from './notification.service';
import { normalizeIp } from '../utils/network.utils';
import { PplnsService } from './pplns.service';

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
    private readonly pplnsService: PplnsService,
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
   * Used by JDP SubmitSolutionJd to populate the Found Block list consistently
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
   * Build Bitcoin consensus-encoded Vec<TxOut> for the JD client.
   * The Rust JD client deserializes this with bitcoin::consensus::deserialize::<Vec<TxOut>>().
   * Format: varint(count) || for each TxOut: u64_le(value) || varint(script_len) || script_bytes
   *
   * Spec 6.4.3: JDS MUST reserve the first output as pool payout.
   * JDS MAY add more 0 value outputs. All outputs have value=0 — JDC allocates
   * the actual block reward at runtime.
   *
   * For PPLNS: sends multiple outputs (pool fee + all eligible miners).
   * For Solo (fallback): sends pool fee address only.
   */
  async getCoinbaseOutputsForToken(): Promise<Buffer> {
    const network = this.getNetwork();
    const addresses: string[] = [];

    if (this.pplnsService.isEnabled()) {
      // PPLNS: get current distribution addresses (fee + miners)
      // Use actual block reward from latest template for correct dust threshold calculation
      const latestTemplate = this.templateDistributionService.getLatestTemplate();
      const blockRewardSats = latestTemplate?.jobTemplate?.blockData?.coinbasevalue ?? 312_500_000;
      const distribution = await this.pplnsService.getPayoutDistribution(blockRewardSats);
      for (const entry of distribution) {
        addresses.push(entry.address);
      }
    }

    // Fallback: pool fee address only
    if (addresses.length === 0) {
      const feeAddress = this.configService.get('PPLNS_FEE_ADDRESS')
        ?? this.configService.get('DEV_FEE_ADDRESS');
      if (feeAddress) {
        addresses.push(feeAddress);
      }
    }

    if (addresses.length === 0) {
      // No addresses at all — return empty outputs
      return Buffer.from([0x00]);
    }

    return this.encodeCoinbaseOutputs(addresses, network);
  }

  /**
   * Encode an array of addresses as Bitcoin consensus Vec<TxOut>, all with 0 sats.
   */
  private encodeCoinbaseOutputs(addresses: string[], network: bitcoinjs.Network): Buffer {
    const parts: Buffer[] = [];

    // VarInt: output count
    if (addresses.length < 253) {
      parts.push(Buffer.from([addresses.length]));
    } else {
      const lenBuf = Buffer.alloc(3);
      lenBuf[0] = 0xfd;
      lenBuf.writeUInt16LE(addresses.length, 1);
      parts.push(lenBuf);
    }

    for (const addr of addresses) {
      const scriptPubKey = bitcoinjs.address.toOutputScript(addr, network);

      // TxOut value: 0 satoshis (u64 LE)
      parts.push(Buffer.alloc(8, 0));

      // Script length (VarInt) + script bytes
      if (scriptPubKey.length < 253) {
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

  private getNetwork(): bitcoinjs.Network {
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
   * during job declaration, enabling block reconstruction via SubmitSolutionJd.
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
   * Called by JobDeclarationClient when SubmitSolutionJd is received.
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
