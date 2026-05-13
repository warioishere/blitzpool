import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
// merkle-lib exports a callable via `module.exports = fn`. TS 6 wraps namespace
// imports in `__importStar`, which yields an object (not callable). Use require
// to get the raw function reference.
const merkle: (leaves: Buffer[], hashFn: (b: Buffer) => Buffer) => Buffer[] = require('merkle-lib');
const merkleProof: (tree: Buffer[], leaf: Buffer) => Buffer[] = require('merkle-lib/proof');
import { combineLatest, filter, from, interval, map, Observable, shareReplay, startWith, switchMap, tap } from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        clearJobs: boolean;

        /**
         * Set when a newer block has been published and this template is no
         * longer the active tip. Templates with `retiredAt` set are still
         * resolvable via `getJobTemplateById` (so late shares can be validated
         * against the work that was actually issued) until they're aged out
         * after `JOB_RETENTION_MS`. See `cleanup()` for the lifecycle.
         */
        retiredAt?: number;
    };
}

// ── Lifecycle constants ──────────────────────────────────────────
//
// Pattern lifted from ckpool's `stratifier.c:1085-1111`. Three knobs:
//
//   STALE_GRACE_MS    — how long after retirement a share against a retired
//                       job is still treated as if it were current (i.e.
//                       fully credited). Absorbs cross-network jitter
//                       between miner and pool. Default 5s — well above
//                       typical network RTT, well below the operator's
//                       perception of "this share isn't really for the
//                       current block anymore".
//
//   JOB_RETENTION_MS  — how long after retirement (or after last write,
//                       for non-retired entries) a job/template stays in
//                       memory before GC. Late shares within this window
//                       resolve to a real entry → rejection is "stale"
//                       not "JobNotFound". Default 10min, plenty for
//                       even the slowest miners' reconnect-then-submit
//                       paths.
//
//   MIN_RETAINED      — never let the in-memory map drop below this many
//                       entries, regardless of age. Defends against the
//                       startup-window where everything is fresh and the
//                       aging rule shouldn't fire yet.
const STALE_GRACE_MS = parseInt(process.env.STRATUM_STALE_GRACE_MS) || 5000;
const MIN_RETAINED = 3;
export { STALE_GRACE_MS };

@Injectable()
export class StratumV1JobsService {

    private lastIntervalCount: number;
    private skipNext: boolean = false;
    public newMiningJob$: Observable<IJobTemplate>;

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    private block_template_interval: number =
      parseInt(process.env.BLOCK_TEMPLATE_INTERVAL) || 60000;

    // Aging window: 10 minutes default. Was 90s under the old "delete on
    // block change" model, where you only needed enough headroom for the
    // periodic-refresh template churn within one block. Under the
    // ckpool-style retire-then-age model (where the block-change retires
    // jobs and keeps them queryable for late-share validation), 10 min
    // is the comfortable budget — long enough that essentially every
    // late share resolves to a real entry, short enough that GC keeps
    // the maps bounded under sustained operation.
    private job_retention_ms: number =
      parseInt(process.env.JOB_RETENTION_MS) || 600000;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {

        this.newMiningJob$ = combineLatest([this.bitcoinRpcService.newBlock$, interval(this.block_template_interval).pipe(startWith(-1))]).pipe(
            switchMap(([miningInfo, interval]) => {
                return from(this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks)).pipe(
                    map((blockTemplate) => {
                        return {
                            blockTemplate,
                            interval
                        }
                    })
                )
            }),
            map(({ blockTemplate, interval }) => {
                const processingStartTime = Date.now();

                let clearJobs = false;
                if (this.lastIntervalCount === interval) {
                    clearJobs = true;
                    this.skipNext = true;
                    console.log('new block')
                }

                if (this.skipNext == true && clearJobs == false) {
                    this.skipNext = false;
                    return null;
                }

                this.lastIntervalCount = interval;

                const currentTime = Math.floor(new Date().getTime() / 1000);
                const result = {
                    version: blockTemplate.version,
                    bits: parseInt(blockTemplate.bits, 16),
                    prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
                    transactions: blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data)),
                    coinbasevalue: blockTemplate.coinbasevalue,
                    timestamp: blockTemplate.mintime > currentTime ? blockTemplate.mintime : currentTime,
                    networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
                    clearJobs,
                    height: blockTemplate.height
                };
                return result;
            }),
            filter(next => next != null),
            map(({ version, bits, prevHash, transactions, timestamp, coinbasevalue, networkDifficulty, clearJobs, height }) => {
                const blockBuildStartTime = Date.now();
                const block = new bitcoinjs.Block();

                //create an empty coinbase tx
                const tempCoinbaseTx = new bitcoinjs.Transaction();
                tempCoinbaseTx.version = 2;
                tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
                tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
                transactions.unshift(tempCoinbaseTx);

                const transactionBuffers = transactions.map(tx => tx.getHash(false));

                const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
                const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
                block.merkleRoot = merkleBranches.pop();

                // remove the first (coinbase) and last (root) element from the branch
                const merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'))

                block.prevHash = prevHash;
                block.version = version;
                block.bits = bits;
                block.timestamp = timestamp;

                block.transactions = transactions;
                block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(transactions, true);

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;

                return {
                    block,
                    merkle_branch,
                    blockData: {
                        id,
                        creation: new Date().getTime(),
                        coinbasevalue,
                        networkDifficulty,
                        height,
                        clearJobs
                    }
                }
            }),
            tap((data) => {
                this.cleanup(data.blockData.clearJobs);
                this.blocks[data.blockData.id] = data;
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        )
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
        const difficulty: number = maxTarget / target;    // Calculate the difficulty

        return difficulty;
    }

    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    /**
     * ckpool-style workbase lifecycle.
     *
     * On block change (`clearJobs=true`) the old behaviour was to wipe the
     * jobs+blocks maps entirely — but the wipe happens in-thread *before* the
     * 400 stratum subscribers fan out the new `mining.notify`, so for the
     * 0.1-2 seconds it takes to dispatch, the pool has no record of the jobs
     * miners are still working against. Any share submitted against the prior
     * block in that window resolves to `null` in `getJobById` and gets
     * rejected as `JobNotFound` — which is both wrong (stale ≠ unknown) and
     * inflates rejected statistics in proportion to pool size.
     *
     * The fix mirrors `ckpool/src/stratifier.c:1085-1111`:
     *
     *   1. Block change does NOT delete — it stamps `retiredAt` on every
     *      currently-known template and job. They stay queryable.
     *   2. Aging deletes ONLY entries whose `retiredAt` is older than the
     *      retention window. A non-retired entry never ages out (the
     *      block-change path will always retire it eventually).
     *   3. Aging respects a floor: keep the newest `MIN_RETAINED` entries
     *      regardless. Defends against startup races and pathological
     *      no-block-for-an-hour scenarios.
     *
     * Validation downstream (in StratumV1Client.handleSubmit and
     * StratumV2Client.handleSubmit) treats a found-but-retired job as:
     *
     *   - Within `STALE_GRACE_MS` of retirement: accept as if current
     *     (network jitter absorption — the share *was* valid work
     *     issued by us, it just took N ms to arrive).
     *   - Beyond grace: reject with "stale" rejection counter (separate
     *     from JobNotFound, so operators can see the two failure modes
     *     distinctly).
     *
     * `JobNotFound` is reserved for the genuine failure: aging actually
     * removed the job, ~10 minutes after the block it belonged to.
     */
    public cleanup(clearJobs: boolean, now: number = Date.now()) {
        if (clearJobs) {
            // Stamp retiredAt on everything currently active. Idempotent —
            // already-retired entries keep their original timestamp.
            for (const id in this.blocks) {
                const t = this.blocks[id];
                if (t.blockData.retiredAt === undefined) {
                    t.blockData.retiredAt = now;
                }
            }
            for (const jobId in this.jobs) {
                const j = this.jobs[jobId];
                if (j.retiredAt === undefined) {
                    j.retiredAt = now;
                }
            }
        }

        this.ageEntries(
            this.blocks,
            now,
            (e) => e.blockData.creation,
            (e) => e.blockData.retiredAt,
        );
        this.ageEntries(
            this.jobs,
            now,
            (e) => e.creation,
            (e) => e.retiredAt,
        );
    }

    private ageEntries<T>(
        map: Record<string, T>,
        now: number,
        getCreation: (entry: T) => number,
        getRetiredAt: (entry: T) => number | undefined,
    ): void {
        const ids = Object.keys(map);
        if (ids.length <= MIN_RETAINED) return;

        // Sort by creation time descending so we never delete the newest
        // MIN_RETAINED entries — they're our floor of "freshness".
        const sortedByCreation = ids
            .slice()
            .sort((a, b) => getCreation(map[b]) - getCreation(map[a]));
        const candidatesForGC = sortedByCreation.slice(MIN_RETAINED);

        for (const id of candidatesForGC) {
            const entry = map[id];
            const retiredAt = getRetiredAt(entry);
            // Only age entries that have been retired AND are past the
            // retention window. Non-retired entries are still potentially
            // active (the periodic 60s refresh creates fresh templates that
            // are NOT retired until the next block change) — leave them be.
            if (retiredAt !== undefined && now - retiredAt > this.job_retention_ms) {
                delete map[id];
                continue;
            }
            // Defense-in-depth: if a non-retired entry somehow piles up
            // (e.g. clock jump, missed retire signal), age it by absolute
            // creation time. Generous window so this almost never fires
            // in normal operation.
            if (now - getCreation(entry) > this.job_retention_ms * 2) {
                delete map[id];
            }
        }
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
        this.latestJobId++;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    /**
     * Classify a share-submit's age against retirement state.
     *
     * Three outcomes:
     *   - `'active'`: job exists and is the current block's job → normal path
     *   - `'stale-creditable'`: job exists, was retired ≤ STALE_GRACE_MS ago →
     *     accept as if current (the work *was* valid; this is just network
     *     jitter)
     *   - `'stale-rejected'`: job exists, was retired > STALE_GRACE_MS ago →
     *     reject with stale rejection counter (NOT JobNotFound — the job
     *     is real, just too late to count)
     *
     * `null` from `getJobById` (i.e. job not in map at all) is the caller's
     * problem to handle as JobNotFound — that's the genuine "this share
     * references work I don't have any record of issuing" case, only
     * reachable after the 10-min retention window has GC'd the entry.
     */
    public classifyJobForShare(job: MiningJob, now: number = Date.now()): 'active' | 'stale-creditable' | 'stale-rejected' {
        if (job.retiredAt === undefined) return 'active';
        return (now - job.retiredAt) <= STALE_GRACE_MS ? 'stale-creditable' : 'stale-rejected';
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }


}
