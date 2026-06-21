// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

// ── Template Distribution Service ──────────────────────────────────
// Wraps existing job templates into SV2 TDP-format data structures.
// Provides an internal API consumed by extended channels and JDP.

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, ReplaySubject, Subscription } from 'rxjs';

import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { Sv2TdpNewTemplate, Sv2TdpSetNewPrevHash, Sv2TdpSubmitSolution } from '../models/sv2/sv2-tdp-messages';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { hasWitnessBytes } from '../utils/bip141.utils';
import { merkleBranchToBuffers } from '../utils/merkle.utils';

interface StoredTemplate {
  template: Sv2TdpNewTemplate;
  prevHash: Sv2TdpSetNewPrevHash;
  jobTemplate: IJobTemplate;
}

@Injectable()
export class TemplateDistributionService implements OnModuleInit {
  private templateIdCounter = 0n;
  private activeTemplates = new Map<bigint, StoredTemplate>();
  private subscription: Subscription | null = null;
  private readonly newTemplateSubject = new ReplaySubject<Sv2TdpNewTemplate>(1);
  private readonly newPrevHashSubject = new ReplaySubject<Sv2TdpSetNewPrevHash>(1);

  public readonly newTemplate$: Observable<Sv2TdpNewTemplate> = this.newTemplateSubject.asObservable();
  public readonly newPrevHash$: Observable<Sv2TdpSetNewPrevHash> = this.newPrevHashSubject.asObservable();

  constructor(
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscription = this.stratumV1JobsService.newMiningJob$.subscribe((jobTemplate) => {
      try {
        this.processJobTemplate(jobTemplate);
      } catch (err) {
        console.error('[TemplateDistribution] Error processing job template:', (err as Error).message);
      }
    });
    console.log('[TemplateDistribution] Initialized');
  }

  private processJobTemplate(jobTemplate: IJobTemplate): void {
    const templateId = ++this.templateIdCounter;
    const isFutureTemplate = !jobTemplate.blockData.clearJobs;

    // Build coinbase prefix: the serialized coinbase transaction up to the extranonce boundary.
    // Reuses the same split logic as MiningJob (lines 79-88).
    const coinbaseTx = jobTemplate.block.transactions?.[0];
    let coinbasePrefix = Buffer.alloc(0);
    let coinbaseTxOutputs = Buffer.alloc(0);

    if (coinbaseTx) {
      // Get the non-witness serialized coinbase
      // @ts-ignore - accessing private __toBuffer method
      const serialized = coinbaseTx.__toBuffer ? coinbaseTx.__toBuffer() : Buffer.alloc(0);
      const inputScript = coinbaseTx.ins[0]?.script;

      if (inputScript && serialized.length > 0) {
        const scriptHex = inputScript.toString('hex');
        const serializedHex = serialized.toString('hex');
        const partOneIndex = serializedHex.indexOf(scriptHex) + scriptHex.length;
        // Prefix includes everything up to (but not including) the extranonce space (last 12 bytes of script: 4 enonce1 + 8 enonce2)
        coinbasePrefix = Buffer.from(serializedHex.slice(0, partOneIndex - 24), 'hex');

        // Strip BIP141 witness marker/flag bytes if present (for extended channels)
        // Witness format: [version:4][MARKER:0x00][FLAG:0x01][inputs...]
        // Non-witness:    [version:4][inputs...]
        if (hasWitnessBytes(coinbasePrefix)) {
          coinbasePrefix = Buffer.concat([
            coinbasePrefix.subarray(0, 4),      // version (4 bytes)
            coinbasePrefix.subarray(6),          // rest after marker+flag
          ]);
          console.log('[TDP] ✂️  Stripped BIP141 witness bytes from coinbase prefix');
        }
      }

      // Serialize outputs
      if (coinbaseTx.outs && coinbaseTx.outs.length > 0) {
        const outputBuffers: Buffer[] = [];
        for (const out of coinbaseTx.outs) {
          const valueBuf = Buffer.alloc(8);
          valueBuf.writeBigInt64LE(BigInt(out.value));
          // CompactSize varint encoding for script length (Bitcoin serialization format)
          const len = out.script.length;
          let scriptLen: Buffer;
          if (len < 0xFD) {
            scriptLen = Buffer.from([len]);
          } else if (len <= 0xFFFF) {
            scriptLen = Buffer.alloc(3);
            scriptLen[0] = 0xFD;
            scriptLen.writeUInt16LE(len, 1);
          } else {
            scriptLen = Buffer.alloc(5);
            scriptLen[0] = 0xFE;
            scriptLen.writeUInt32LE(len, 1);
          }
          outputBuffers.push(valueBuf, scriptLen, out.script);
        }
        coinbaseTxOutputs = Buffer.concat(outputBuffers);
      }
    }

    // Build merkle path from merkle_branch (hex strings → 32-byte Buffers)
    const merklePath = merkleBranchToBuffers(jobTemplate.merkle_branch);

    const template: Sv2TdpNewTemplate = {
      templateId,
      futureTemplate: isFutureTemplate,
      version: jobTemplate.block.version,
      coinbasePrefix,
      coinbaseTxVersion: coinbaseTx?.version ?? 2,
      coinbaseTxInputSequence: coinbaseTx?.ins[0]?.sequence ?? 0xffffffff,
      coinbaseTxValueRemaining: BigInt(jobTemplate.blockData.coinbasevalue),
      coinbaseTxOutputsCount: coinbaseTx?.outs?.length ?? 0,
      coinbaseTxOutputs,
      coinbaseTxLocktime: coinbaseTx?.locktime ?? 0,
      merklePath,
    };

    const prevHash = jobTemplate.block.prevHash
      ? Buffer.from(jobTemplate.block.prevHash)
      : Buffer.alloc(32);

    const target = DifficultyUtils.difficultyToTarget(jobTemplate.blockData.networkDifficulty);

    const tdpPrevHash: Sv2TdpSetNewPrevHash = {
      templateId,
      prevHash,
      headerTimestamp: jobTemplate.block.timestamp,
      nBits: jobTemplate.block.bits,
      target,
    };

    // Store for later lookups
    this.activeTemplates.set(templateId, { template, prevHash: tdpPrevHash, jobTemplate });

    // Clean up old templates (keep last 10)
    if (this.activeTemplates.size > 10) {
      const oldestKey = this.activeTemplates.keys().next().value;
      if (oldestKey !== undefined) {
        this.activeTemplates.delete(oldestKey);
      }
    }

    // Emit
    this.newTemplateSubject.next(template);
    console.log(`[TDP] 📋 NewTemplate: id=${templateId}, version=0x${template.version.toString(16)}, coinbaseValue=${template.coinbaseTxValueRemaining.toString()}, outputs=${template.coinbaseTxOutputsCount}, merklePathLen=${merklePath.length}, futureTemplate=${isFutureTemplate}`);

    if (jobTemplate.blockData.clearJobs) {
      this.newPrevHashSubject.next(tdpPrevHash);
      console.log(`[TDP] 🔗 SetNewPrevHash: id=${templateId}, height=${jobTemplate.blockData.height}, prevHash=${prevHash.toString('hex').substring(0, 16)}..., nBits=0x${tdpPrevHash.nBits.toString(16)}`);
    }
  }

  getTemplate(templateId: bigint): StoredTemplate | undefined {
    return this.activeTemplates.get(templateId);
  }

  getLatestTemplate(): StoredTemplate | undefined {
    if (this.activeTemplates.size === 0) return undefined;
    let latest: StoredTemplate | undefined;
    for (const stored of this.activeTemplates.values()) {
      latest = stored;
    }
    return latest;
  }

  async handleSubmitSolution(solution: Sv2TdpSubmitSolution): Promise<{ result: string; blockHex: string; height: number; coinbasevalue: number } | string> {
    console.log(`[TDP] 📤 SubmitSolution: templateId=${solution.templateId}, version=0x${solution.version.toString(16)}, nonce=0x${solution.headerNonce.toString(16).padStart(8, '0')}, coinbaseTxLen=${solution.coinbaseTx.length}`);

    const stored = this.activeTemplates.get(solution.templateId);
    if (!stored) {
      console.warn(`[TDP] ❌ Solution rejected: template-not-found (templateId=${solution.templateId})`);
      return 'template-not-found';
    }

    // Reconstruct block from template + solution
    const jobTemplate = stored.jobTemplate;
    const block = Object.assign(
      Object.create(Object.getPrototypeOf(jobTemplate.block)),
      jobTemplate.block,
    );
    block.transactions = jobTemplate.block.transactions.map((tx) =>
      Object.assign(Object.create(Object.getPrototypeOf(tx)), tx),
    );

    // Replace coinbase with submitted coinbase
    if (solution.coinbaseTx.length > 0) {
      try {
        const bitcoinjs = require('bitcoinjs-lib');
        block.transactions[0] = bitcoinjs.Transaction.fromBuffer(solution.coinbaseTx);
      } catch {
        return 'invalid-coinbase';
      }
    }

    // Apply solution header fields
    block.version = solution.version;
    block.timestamp = solution.headerTimestamp;
    block.nonce = solution.headerNonce;

    // Recompute merkle root
    const bitcoinjs = require('bitcoinjs-lib');
    block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);

    // Submit to bitcoin node
    const blockHex = block.toHex(false);
    const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);

    if (result === 'SUCCESS!') {
      console.log(`[TDP] 🎉🎉🎉 BLOCK ACCEPTED!!! Height: ${jobTemplate.blockData.height}, via SubmitSolution`);
    } else {
      console.warn(`[TDP] ❌ Block rejected: ${result}`);
    }

    return {
        result,
        blockHex,
        height: jobTemplate.blockData.height,
        // K5: needed by StratumV2Client.handleSubmitSolution to route
        // pplnsService.onBlockFound / groupSoloService.onBlockFound
        // after a successful TDP-path block submit. The extended-channel
        // path has the value via its in-memory jobTemplate; the TDP
        // path goes through the SRI template store, so we surface it here.
        coinbasevalue: jobTemplate.blockData.coinbasevalue,
    };
  }
}
