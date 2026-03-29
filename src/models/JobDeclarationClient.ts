// ── Job Declaration Client (JDC connection handler) ────────────────
// Manages a single JDP connection from a Job Declarator Client (JDC)
// to the pool acting as a Job Declarator Server (JDS).

import * as crypto from 'crypto';
import { Socket } from 'net';
import * as bitcoinjs from 'bitcoinjs-lib';

import { Sv2NoiseSession } from './sv2/sv2-noise';
import { Sv2FrameReader, Sv2FrameWriter } from './sv2/sv2-frame';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
  Sv2MsgType,
  SV2_NOISE_ACT1_SIZE,
  Sv2Protocol,
} from './sv2/sv2-constants';
import {
  deserializeSetupConnection,
  serializeSetupConnectionSuccess,
  serializeSetupConnectionError,
} from './sv2/sv2-messages';
import {
  deserializeAllocateMiningJobToken,
  serializeAllocateMiningJobTokenSuccess,
  deserializeDeclareMiningJob,
  serializeDeclareMiningJobSuccess,
  serializeDeclareMiningJobError,
  serializeProvideMissingTransactions,
  deserializeProvideMissingTransactionsSuccess,
  deserializeSubmitSolutionJd,
  Sv2DeclareMiningJob,
} from './sv2/sv2-jdp-messages';
import { DifficultyUtils } from '../utils/difficulty.utils';

export interface JobDeclarationServiceRef {
  getNoiseConfig(): any;
  validateTransactions(txHashes: string[]): Promise<{ known: string[]; unknown: string[] }>;
  onJobDeclared(clientId: string, job: Sv2DeclareMiningJob, token: Buffer): void;
  getConfigValue(key: string): string | undefined;
  getMinerAddressByIp(remoteIp: string): string | null;
  getMinerInfoByIp(remoteIp: string): { address: string; worker: string; sessionId: string } | null;
  getBlockHeight(): number;
  getCoinbaseOutputsForToken(): Promise<Buffer>;
  getTemplateTransactions(): Map<string, Buffer>;
  getCurrentPrevHash(): Buffer | null;
  getRawTransaction(txid: string): Promise<Buffer | null>;
  submitBlock(blockHex: string): Promise<string>;
  saveBlock(data: { height: number; minerAddress: string; worker: string; sessionId: string; blockData: string }): Promise<void>;
  notifyBlockFound(address: string, height: number, result: string): Promise<void>;
}

export class JobDeclarationClient {
  private noiseSession: Sv2NoiseSession;
  private frameReader: Sv2FrameReader;
  private frameWriter: Sv2FrameWriter;
  private destroyed = false;

  public readonly clientId: string;
  public readonly remoteAddress: string;
  private tokenCounter = 0;
  private allocatedTokens = new Map<string, {
    token: Buffer;
    expiresAt: number;
    coinbaseOutputs: Buffer; // Pool payout outputs sent with this token
  }>();

  // Connection state: tracks SetupConnection negotiation (spec 6.4.1/6.4.2)
  private setupComplete = false;
  private fullTemplateMode = false; // true when DECLARE_TX_DATA flag (bit 0) negotiated

  // Rate limiting for AllocateMiningJobToken (spec 6.4.2: "rate limited to a rather slow rate")
  private lastTokenAllocAt = 0;
  private static readonly TOKEN_ALLOC_MIN_INTERVAL_MS = 1000; // 1 second minimum between allocations

  // Pending declaration state (between ProvideMissingTransactions request and response)
  private pendingDeclaration: {
    requestId: number;
    job: Sv2DeclareMiningJob;
    unknownPositions: number[];
    knownRawTxs: Map<number, Buffer>;
  } | null = null;

  // Declared job data keyed by token hex — supports multiple active jobs for block reconstruction
  private declaredJobs = new Map<string, {
    job: Sv2DeclareMiningJob;
    newToken: Buffer;
    rawTransactions: Map<number, Buffer>;
    prevHash: Buffer | null; // Template prevHash at time of declaration, for PushSolution matching
    declaredAt: number;
  }>();

  constructor(
    private readonly socket: Socket,
    firstChunk: Buffer,
    private readonly service: JobDeclarationServiceRef,
  ) {
    this.clientId = crypto.randomBytes(4).toString('hex');
    this.remoteAddress = socket.remoteAddress || '';

    this.noiseSession = new Sv2NoiseSession(this.service.getNoiseConfig());
    this.frameReader = new Sv2FrameReader(null);
    this.frameWriter = new Sv2FrameWriter(null);

    socket.setTimeout(1000 * 60 * 5);
    socket.on('close', () => this.handleClose());
    socket.on('timeout', () => this.handleTimeout());
    socket.on('error', (err) => this.handleError(err));

    this.performHandshake(firstChunk).catch((err) => {
      console.error(`[JDP ${this.clientId}] Handshake failed:`, err.message);
      this.destroySocket();
    });
  }

  private async performHandshake(firstChunk: Buffer): Promise<void> {
    console.log(`[JDP ${this.clientId}] 🔌 New JDP connection from ${this.socket.remoteAddress}`);

    if (firstChunk.length < SV2_NOISE_ACT1_SIZE) {
      throw new Error(`First chunk too short for Act 1: ${firstChunk.length} bytes`);
    }

    const act1 = firstChunk.subarray(0, SV2_NOISE_ACT1_SIZE);
    const remainder = firstChunk.subarray(SV2_NOISE_ACT1_SIZE);

    console.log(`[JDP ${this.clientId}] 🔐 Noise Act 1 received (${act1.length} bytes)`);

    const act2 = await this.noiseSession.processAct1(act1);
    await this.writeRaw(act2);

    console.log(`[JDP ${this.clientId}] 🔐 Noise Act 2 sent (${act2.length} bytes)`);

    this.frameReader.setDecryptFn(this.noiseSession.decrypt.bind(this.noiseSession));
    this.frameWriter.setEncryptFn(this.noiseSession.encrypt.bind(this.noiseSession));

    this.socket.on('data', (data: Buffer) => {
      if (this.destroyed) return;
      try {
        const frames = this.frameReader.feed(data);
        for (const frame of frames) {
          this.handleFrame(frame.header.msgType, frame.payload).catch((err) => {
            console.error(`[JDP ${this.clientId}] Frame handling error:`, err.message);
            this.destroySocket();
          });
        }
      } catch (err) {
        console.error(`[JDP ${this.clientId}] Frame read error:`, (err as Error).message);
        this.destroySocket();
      }
    });

    if (remainder.length > 0) {
      const frames = this.frameReader.feed(remainder);
      for (const frame of frames) {
        await this.handleFrame(frame.header.msgType, frame.payload);
      }
    }

    console.log(`[JDP ${this.clientId}] ✅ Noise handshake complete, transport encrypted`);
  }

  private async handleFrame(msgType: number, payload: Buffer): Promise<void> {
    switch (msgType) {
      case Sv2MsgType.SETUP_CONNECTION:
        await this.handleSetupConnection(payload);
        break;
      case Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN:
        await this.handleAllocateToken(payload);
        break;
      case Sv2MsgType.JDP_DECLARE_MINING_JOB:
        await this.handleDeclareMiningJob(payload);
        break;
      case Sv2MsgType.JDP_PROVIDE_MISSING_TRANSACTIONS_SUCCESS:
        await this.handleProvideMissingTransactionsSuccess(payload);
        break;
      case Sv2MsgType.JDP_SUBMIT_SOLUTION:
        await this.handleSubmitSolutionJd(payload);
        break;
      default:
        console.warn(`[JDP ${this.clientId}] Unknown message type: 0x${msgType.toString(16)}`);
        break;
    }
  }

  private async handleSetupConnection(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeSetupConnection(reader);

    console.log(`[JDP ${this.clientId}] 📋 SetupConnection: vendor=${msg.vendor}, firmware=${msg.firmwareVersion}, device=${msg.deviceId}, version=${msg.minVersion}-${msg.maxVersion}, protocol=${msg.protocol === Sv2Protocol.JOB_DECLARATION ? 'JOB_DECLARATION' : 'OTHER'}`);

    // Validate protocol = JOB_DECLARATION (spec 6.4.1)
    if (msg.protocol !== Sv2Protocol.JOB_DECLARATION) {
      console.error(`[JDP ${this.clientId}] ❌ Protocol mismatch: expected JOB_DECLARATION (${Sv2Protocol.JOB_DECLARATION}), got ${msg.protocol}`);
      const errorPayload = serializeSetupConnectionError({
        flags: msg.flags,
        errorCode: 'unsupported-protocol',
      });
      await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, errorPayload);
      this.destroySocket();
      return;
    }

    if (msg.minVersion > 2 || msg.maxVersion < 2) {
      console.error(`[JDP ${this.clientId}] ❌ Unsupported version range: ${msg.minVersion}-${msg.maxVersion} (pool requires v2)`);
      const errorPayload = serializeSetupConnectionError({
        flags: msg.flags,
        errorCode: 'unsupported-version',
      });
      await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, errorPayload);
      this.destroySocket();
      return;
    }

    // Echo back the DECLARE_TX_DATA flag (bit 0) per spec 6.4.1:
    // flags=1 → Full-Template mode (JDC sends DeclareMiningJob before SetCustomMiningJob)
    // flags=0 → Coinbase-only mode (JDC sends SetCustomMiningJob directly)
    const negotiatedFlags = msg.flags & 1;
    this.fullTemplateMode = (negotiatedFlags & 1) === 1;
    this.setupComplete = true;

    const successPayload = serializeSetupConnectionSuccess({
      usedVersion: 2,
      flags: negotiatedFlags,
    });
    await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_SUCCESS, successPayload);

    console.log(`[JDP ${this.clientId}] ✅ SetupConnectionSuccess: version=2, flags=${negotiatedFlags} (${this.fullTemplateMode ? 'Full-Template' : 'Coinbase-only'})`);
  }

  private async handleAllocateToken(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeAllocateMiningJobToken(reader);

    console.log(`[JDP ${this.clientId}] 📋 AllocateMiningJobToken: userIdentifier=${msg.userIdentifier}, requestId=${msg.requestId}`);

    // Spec 6.4.2: "only available on connections where this has been negotiated"
    if (!this.setupComplete) {
      console.warn(`[JDP ${this.clientId}] ⚠️  AllocateMiningJobToken before SetupConnection, ignoring`);
      return;
    }

    // Rate limit token allocations (spec 6.4.2: "rate limited to a rather slow rate")
    const now = Date.now();
    if (now - this.lastTokenAllocAt < JobDeclarationClient.TOKEN_ALLOC_MIN_INTERVAL_MS) {
      console.warn(`[JDP ${this.clientId}] ⚠️  AllocateMiningJobToken rate limited (${now - this.lastTokenAllocAt}ms since last)`);
      return;
    }
    this.lastTokenAllocAt = now;

    // user_identifier is used for identification/logging only — not for coinbase construction.
    // Coinbase outputs come from the pool's PPLNS distribution (or pool fee address).
    console.log(`[JDP ${this.clientId}] 📍 user_identifier: "${msg.userIdentifier.trim()}" (used for identification only)`);

    // Generate unique opaque token
    const token = this.generateToken();

    // Build coinbase outputs from PPLNS distribution (or pool fee fallback)
    const coinbaseOutputs = await this.service.getCoinbaseOutputsForToken();

    // Store with 1-hour expiry, including the coinbase outputs for later validation
    const tokenHex = token.toString('hex');
    this.allocatedTokens.set(tokenHex, {
      token,
      expiresAt: Date.now() + 3600000,
      coinbaseOutputs,
    });

    const successPayload = serializeAllocateMiningJobTokenSuccess({
      requestId: msg.requestId,
      miningJobToken: token,
      coinbaseOutputs,
    });
    await this.sendFrame(Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN_SUCCESS, successPayload);

    console.log(`[JDP ${this.clientId}] ✅ AllocateMiningJobTokenSuccess: token=${tokenHex.substring(0, 16)}..., coinbaseOutputsLen=${coinbaseOutputs.length}, outputCount=${coinbaseOutputs[0]}`);
  }

  private async handleDeclareMiningJob(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const job = deserializeDeclareMiningJob(reader);

    console.log(`[JDP ${this.clientId}] 📋 DeclareMiningJob: version=0x${job.version.toString(16)}, wtxidCount=${job.wtxidList.length}, coinbaseTxPrefixLen=${job.coinbaseTxPrefix.length}, token=${job.miningJobToken.toString('hex').substring(0, 16)}...`);

    // Spec 6.4.4: "Only used in Full-Template mode"
    if (!this.fullTemplateMode) {
      console.warn(`[JDP ${this.clientId}] ❌ DeclareMiningJob rejected: not in Full-Template mode (DECLARE_TX_DATA not negotiated)`);
      const errorPayload = serializeDeclareMiningJobError({
        requestId: job.requestId,
        errorCode: 'unsupported-feature-flags',
        errorDetails: Buffer.from('DeclareMiningJob requires Full-Template mode (DECLARE_TX_DATA flag)'),
      });
      await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, errorPayload);
      return;
    }

    // Validate token
    const tokenHex = job.miningJobToken.toString('hex');
    const tokenEntry = this.allocatedTokens.get(tokenHex);

    if (!tokenEntry) {
      console.warn(`[JDP ${this.clientId}] ❌ DeclareMiningJob rejected: invalid-mining-job-token (token not found)`);
      const errorPayload = serializeDeclareMiningJobError({
        requestId: job.requestId,
        errorCode: 'invalid-mining-job-token',
        errorDetails: Buffer.from('Token not found or expired'),
      });
      await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, errorPayload);
      return;
    }

    // Check token expiry
    if (Date.now() > tokenEntry.expiresAt) {
      this.allocatedTokens.delete(tokenHex);
      console.warn(`[JDP ${this.clientId}] ❌ DeclareMiningJob rejected: invalid-mining-job-token (token expired)`);
      const errorPayload = serializeDeclareMiningJobError({
        requestId: job.requestId,
        errorCode: 'invalid-mining-job-token',
        errorDetails: Buffer.from('Token expired'),
      });
      await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, errorPayload);
      return;
    }

    // Validate wtxids directly against mempool (no IdentifyTransactions step)
    if (job.wtxidList.length > 0) {
      // SV2 sends wtxids in wire byte order (little-endian), but Bitcoin Core RPC
      // and bitcoinjs-lib return hashes in display format (reversed). Reverse to match.
      const txHashes = job.wtxidList.map((h) => Buffer.from(h).reverse().toString('hex'));
      const { known, unknown } = await this.service.validateTransactions(txHashes);

      console.log(`[JDP ${this.clientId}] 🔍 Transaction validation: ${known.length} known, ${unknown.length} unknown (out of ${txHashes.length} total)`);

      // Collect raw tx data from our own template for transactions we have locally.
      // Any transaction we don't have raw data for — whether unknown to our mempool
      // or just not in our template — gets requested from the JDC via ProvideMissingTransactions.
      const templateTxs = this.service.getTemplateTransactions();
      const knownRawTxs = new Map<number, Buffer>();
      const missingPositions: number[] = [];

      for (let i = 0; i < txHashes.length; i++) {
        const rawTx = templateTxs.get(txHashes[i]);
        if (rawTx) {
          knownRawTxs.set(i, rawTx);
        } else {
          missingPositions.push(i);
        }
      }

      console.log(`[JDP ${this.clientId}] 📦 Template coverage: ${knownRawTxs.size}/${txHashes.length}, mempool-unknown: ${unknown.length}, requesting: ${missingPositions.length}`);

      if (missingPositions.length > 0) {
        // Store pending declaration with known raw txs
        this.pendingDeclaration = { requestId: job.requestId, job, unknownPositions: missingPositions, knownRawTxs };

        // Request raw data from JDC for all transactions we don't have
        const providePayload = serializeProvideMissingTransactions({
          requestId: job.requestId,
          unknownTxPositionList: missingPositions,
        });
        await this.sendFrame(Sv2MsgType.JDP_PROVIDE_MISSING_TRANSACTIONS, providePayload);
        return;
      }

      console.log(`[JDP ${this.clientId}] ✅ All transactions available from template, accepting job`);
      await this.acceptDeclaration(job, knownRawTxs);
      return;
    }

    console.log(`[JDP ${this.clientId}] ✅ No transactions to validate, accepting immediately`);
    await this.acceptDeclaration(job, new Map());
  }

  private async handleProvideMissingTransactionsSuccess(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const msg = deserializeProvideMissingTransactionsSuccess(reader);

    if (!this.pendingDeclaration) {
      console.warn(`[JDP ${this.clientId}] ⚠️  Unexpected ProvideMissingTransactions.Success (no pending declaration)`);
      return;
    }

    // The pool should only reject for technical invalidity (malformed txs, double-spends),
    // NOT for transaction content — this is the censorship resistance guarantee
    console.log(`[JDP ${this.clientId}] 📥 Received ${msg.transactionList.length} missing transactions (${msg.transactionList.reduce((sum, tx) => sum + tx.length, 0)} bytes total)`);

    // Merge provided raw txs with known raw txs
    const mergedRawTxs = new Map<number, Buffer>(this.pendingDeclaration.knownRawTxs);
    for (let i = 0; i < msg.transactionList.length; i++) {
      mergedRawTxs.set(this.pendingDeclaration.unknownPositions[i], msg.transactionList[i]);
    }

    const job = this.pendingDeclaration.job;
    this.pendingDeclaration = null;
    await this.acceptDeclaration(job, mergedRawTxs);
  }

  private async acceptDeclaration(job: Sv2DeclareMiningJob, rawTransactions: Map<number, Buffer>): Promise<void> {
    console.log(`[JDP ${this.clientId}] 🔍 Validating declared job...`);

    // Validate coinbase outputs include the pool payout output (spec 6.4.3)
    const tokenHex = job.miningJobToken.toString('hex');
    const validationError = this.validateCoinbaseOutputs(job, tokenHex);
    if (validationError) {
      console.warn(`[JDP ${this.clientId}] ❌ DeclareMiningJobError: invalid-job-param-value-coinbase_tx_outputs - ${validationError}`);
      const errorPayload = serializeDeclareMiningJobError({
        requestId: job.requestId,
        errorCode: 'invalid-job-param-value-coinbase_tx_outputs',
        errorDetails: Buffer.from(validationError),
      });
      await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, errorPayload);
      return;
    }

    // Generate a new token for the declared job
    const newToken = this.generateToken();

    const successPayload = serializeDeclareMiningJobSuccess({
      requestId: job.requestId,
      newMiningJobToken: newToken,
    });
    await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_SUCCESS, successPayload);

    console.log(`[JDP ${this.clientId}] ✅ DeclareMiningJobSuccess: newToken=${newToken.toString('hex').substring(0, 16)}...`);

    // Store job data keyed by token for block reconstruction via PushSolution.
    // Capture current template prevHash for matching PushSolution.prev_hash (spec 6.4.9).
    const currentPrevHash = this.service.getCurrentPrevHash();
    const tokenKey = newToken.toString('hex');
    this.declaredJobs.set(tokenKey, { job, newToken, rawTransactions, prevHash: currentPrevHash, declaredAt: Date.now() });

    // Keep only the most recent 3 declared jobs to prevent memory bloat.
    // Each job stores ~1-2 MB of raw transaction data, and new declarations
    // arrive every ~5 seconds. SubmitSolutionJd will always target a recent job.
    const MAX_DECLARED_JOBS = 3;
    if (this.declaredJobs.size > MAX_DECLARED_JOBS) {
      // Map iteration order is insertion order — delete oldest entries
      let toDelete = this.declaredJobs.size - MAX_DECLARED_JOBS;
      for (const key of this.declaredJobs.keys()) {
        if (toDelete <= 0) break;
        this.declaredJobs.delete(key);
        toDelete--;
      }
    }

    // Verify raw tx coverage for block reconstruction
    const coveredCount = rawTransactions.size;
    const totalCount = job.wtxidList.length;
    console.log(`[JDP ${this.clientId}] ✅ All ${totalCount} raw transactions stored for block reconstruction (${coveredCount} total)`);

    // Notify the service about the declared job
    this.service.onJobDeclared(this.clientId, job, newToken);
  }

  private async handleSubmitSolutionJd(payload: Buffer): Promise<void> {
    const reader = new BufferReader(payload);
    const solution = deserializeSubmitSolutionJd(reader);

    console.log(`[JDP ${this.clientId}] 📤 PushSolution: version=0x${solution.version.toString(16)}, nonce=0x${solution.nonce.toString(16).padStart(8, '0')}, ntime=${solution.ntime}, prevHash=${solution.prevHash.toString('hex').substring(0, 16)}..., extranonce=${solution.extranonce.toString('hex')}`);

    // Spec 6.4.9: "Only used in Full-Template mode"
    if (!this.fullTemplateMode) {
      console.warn(`[JDP ${this.clientId}] ⚠️  PushSolution ignored: not in Full-Template mode`);
      return;
    }

    // Match the solution to a declared job using prev_hash (spec 6.4.9).
    // PushSolution carries prev_hash to identify which template the solution belongs to.
    // We store the template's prevHash at declaration time for exact matching.
    // Fall back to most recent if no prevHash match (e.g. prevHash wasn't available at
    // declaration time, matching the reference impl behavior).
    const solutionPrevHash = solution.prevHash;
    let matchedJob: { job: Sv2DeclareMiningJob; rawTransactions: Map<number, Buffer> } | null = null;
    let prevHashMatchedJob: typeof matchedJob = null;
    let prevHashMatchedAt = 0;
    let bestDeclaredAt = 0;

    for (const entry of this.declaredJobs.values()) {
      // Prefer a job whose stored prevHash matches the solution's prevHash
      if (entry.prevHash && entry.prevHash.equals(solutionPrevHash) && entry.declaredAt >= prevHashMatchedAt) {
        prevHashMatchedAt = entry.declaredAt;
        prevHashMatchedJob = { job: entry.job, rawTransactions: entry.rawTransactions };
      }
      // Track most recent as fallback
      if (entry.declaredAt >= bestDeclaredAt) {
        bestDeclaredAt = entry.declaredAt;
        matchedJob = { job: entry.job, rawTransactions: entry.rawTransactions };
      }
    }

    // Use prevHash-matched job if available, otherwise fall back to most recent
    if (prevHashMatchedJob) {
      matchedJob = prevHashMatchedJob;
    }

    if (!matchedJob) {
      console.warn(`[JDP ${this.clientId}] ❌ SubmitSolutionJd rejected: no declared jobs stored`);
      return;
    }

    const { job, rawTransactions } = matchedJob;

    try {
      // 1. Reconstruct coinbase transaction
      const coinbaseRaw = Buffer.concat([
        job.coinbaseTxPrefix,
        solution.extranonce,
        job.coinbaseTxSuffix,
      ]);

      let coinbaseTx: bitcoinjs.Transaction;
      try {
        coinbaseTx = bitcoinjs.Transaction.fromBuffer(coinbaseRaw);
      } catch (e) {
        console.error(`[JDP ${this.clientId}] ❌ SubmitSolutionJd: invalid coinbase reconstruction: ${(e as Error).message}`);
        return;
      }

      // 2. Parse all other transactions
      const transactions: bitcoinjs.Transaction[] = [coinbaseTx];
      for (let i = 0; i < job.wtxidList.length; i++) {
        const rawTx = rawTransactions.get(i);
        if (!rawTx) {
          console.error(`[JDP ${this.clientId}] ❌ SubmitSolutionJd: missing raw tx data at position ${i}, cannot reconstruct block`);
          return;
        }
        try {
          transactions.push(bitcoinjs.Transaction.fromBuffer(rawTx));
        } catch (e) {
          console.error(`[JDP ${this.clientId}] ❌ SubmitSolutionJd: invalid transaction at position ${i}: ${(e as Error).message}`);
          return;
        }
      }

      // 3. Build block
      const block = new bitcoinjs.Block();
      block.version = solution.version;
      block.prevHash = solution.prevHash;
      block.timestamp = solution.ntime;
      block.bits = solution.nBits;
      block.nonce = solution.nonce;
      block.transactions = transactions;

      // 4. Compute merkle root from all transaction txids
      block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(transactions, false);

      // 5. Verify PoW meets network target
      const header = block.toBuffer(true);
      const { submissionDifficulty, submissionHash } = DifficultyUtils.calculateDifficulty(header);

      console.log(`[JDP ${this.clientId}] 🎯 SubmitSolutionJd difficulty: ${submissionDifficulty.toFixed(2)}, hash=${submissionHash.substring(0, 32)}...`);

      // 6. Submit block to Bitcoin Core (redundant safety net — JDC also submits via TP)
      const blockHex = block.toHex(false);
      const blockHeight = this.service.getBlockHeight();
      console.log(`[JDP ${this.clientId}] 🎉🎉🎉 BLOCK FOUND via JDP SubmitSolutionJd!!! Height: ${blockHeight}, Submitting... (${transactions.length} txs, ${blockHex.length / 2} bytes)`);

      const result = await this.service.submitBlock(blockHex);

      // Get miner info from the mining connection for consistent Found Block list
      const minerInfo = this.service.getMinerInfoByIp(this.remoteAddress);
      const minerAddress = minerInfo?.address || this.service.getMinerAddressByIp(this.remoteAddress) || 'unknown';
      const worker = minerInfo?.worker || 'jdp-client';
      const sessionId = minerInfo?.sessionId || this.clientId;

      await this.service.saveBlock({
        height: blockHeight,
        minerAddress,
        worker,
        sessionId,
        blockData: blockHex,
      });
      await this.service.notifyBlockFound(minerAddress, blockHeight, result);

      if (result === 'SUCCESS!') {
        console.log(`[JDP ${this.clientId}] ✅ Block accepted by Bitcoin Core! Height: ${blockHeight}, Miner: ${minerAddress}, Worker: ${worker}`);
      } else {
        console.warn(`[JDP ${this.clientId}] ❌ Block rejected by Bitcoin Core: ${result}`);
      }
    } catch (e) {
      console.error(`[JDP ${this.clientId}] ❌ SubmitSolutionJd block reconstruction failed:`, (e as Error).message);
    }
  }

  /**
   * Validate that the declared coinbase includes the pool's payout output script.
   * Per spec 6.4.3: "JDS and Pool SHOULD reject custom jobs that fail to
   * [allocate sats into the pool payout output]."
   *
   * We extract the pool payout locking script (first output from AllocateMiningJobToken.Success)
   * and verify it appears in the coinbaseTxSuffix of the declared job.
   * Returns error message if invalid, null if valid.
   */
  private validateCoinbaseOutputs(job: Sv2DeclareMiningJob, tokenHex: string): string | null {
    // Basic validation: ensure coinbase prefix and suffix are non-empty
    if (job.coinbaseTxPrefix.length === 0 && job.coinbaseTxSuffix.length === 0) {
      return 'Empty coinbase transaction';
    }

    // Retrieve the coinbase outputs we sent with the token
    const tokenEntry = this.allocatedTokens.get(tokenHex);
    if (!tokenEntry || !tokenEntry.coinbaseOutputs || tokenEntry.coinbaseOutputs.length === 0) {
      return null; // No outputs to validate against
    }

    // Parse ALL pool output scripts from coinbaseOutputs and verify each is present.
    // Format: varint(count) || for each: TxOut(value u64_le || varint(scriptLen) || scriptBytes)
    const poolOutputs = tokenEntry.coinbaseOutputs;
    try {
      let offset = 0;

      // Read varint count
      let count = poolOutputs[offset];
      if (count < 0xfd) {
        offset += 1;
      } else if (count === 0xfd) {
        count = poolOutputs.readUInt16LE(offset + 1);
        offset += 3;
      } else {
        return null; // Very large count, skip validation
      }
      if (count === 0) return null;

      // Validate each output script is present in the coinbase suffix
      for (let i = 0; i < count; i++) {
        // Skip value (8 bytes)
        offset += 8;

        // Read script length (varint)
        let scriptLen = poolOutputs[offset];
        if (scriptLen < 0xfd) {
          offset += 1;
        } else if (scriptLen === 0xfd) {
          scriptLen = poolOutputs.readUInt16LE(offset + 1);
          offset += 3;
        } else {
          return null; // Unusual encoding, skip
        }

        const script = poolOutputs.subarray(offset, offset + scriptLen);
        offset += scriptLen;

        // Verify this script appears in coinbaseTxSuffix
        if (job.coinbaseTxSuffix.indexOf(script) === -1) {
          return `Pool output #${i} script not found in coinbase — JDC must include all pool payout outputs`;
        }
      }
    } catch {
      console.warn(`[JDP ${this.clientId}] ⚠️  Could not parse pool payout outputs for validation, skipping`);
      return null;
    }

    return null; // All outputs validated
  }

  /**
   * Heuristic: does this string look like a Bitcoin address?
   * Covers bech32/bech32m (bc1/tb1) and legacy Base58 (1/3/m/n/2) formats.
   */
  private looksLikeBitcoinAddress(s: string): boolean {
    return /^(bc1|tb1|bcrt1|1|3|m|n|2)[a-zA-Z0-9]{24,89}$/.test(s);
  }

  private generateToken(): Buffer {
    this.tokenCounter++;
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(this.tokenCounter, 0);
    crypto.randomBytes(12).copy(buf, 4);
    return buf;
  }

  private async sendFrame(msgType: number, payload: Buffer): Promise<void> {
    if (this.destroyed) return;

    const frame = this.frameWriter.writeFrame(
      { extensionType: 0, msgType, msgLength: payload.length },
      payload,
    );
    await this.writeRaw(frame);
  }

  private async writeRaw(data: Buffer): Promise<void> {
    if (this.socket.destroyed || this.socket.writableEnded) return;
    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // Cleanup
  private handleClose(): void {
    this.destroy();
  }

  private handleTimeout(): void {
    console.log(`[JDP ${this.clientId}] Socket timeout`);
    this.socket.end();
    this.socket.destroy();
  }

  private handleError(err: NodeJS.ErrnoException): void {
    if (err.code !== 'ECONNRESET') {
      console.error(`[JDP ${this.clientId}] Socket error:`, err.message);
    }
    this.socket.destroy();
  }

  private destroySocket(): void {
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.allocatedTokens.clear();
    this.declaredJobs.clear();
    console.log(`[JDP ${this.clientId}] Client disconnected`);
  }
}
