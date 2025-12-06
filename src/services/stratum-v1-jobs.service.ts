import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { combineLatest, delay, filter, from, interval, map, Observable, shareReplay, startWith, switchMap, tap } from 'rxjs';

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
    };
}

@Injectable()
export class StratumV1JobsService {

    private lastIntervalCount: number;
    private skipNext: boolean = false;
    public newMiningJob$: Observable<IJobTemplate>;

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    // offset the interval so that all the cluster processes don't try and refresh at the same time.
    private delay = process.env.NODE_APP_INSTANCE == null ? 0 : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

    private block_template_interval: number =
      parseInt(process.env.BLOCK_TEMPLATE_INTERVAL) || 60000;

    private job_retention_ms: number =
      parseInt(process.env.JOB_RETENTION_MS) || 90000;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {

        this.newMiningJob$ = combineLatest([this.bitcoinRpcService.newBlock$, interval(this.block_template_interval).pipe(delay(this.delay), startWith(-1))]).pipe(
            tap(() => {
                // Job observable triggered by combineLatest
                console.log(`[JOB_TIMING] Observable triggered by combineLatest`);
            }),
            switchMap(([miningInfo, interval]) => {
                const rpcStartTime = Date.now();
                console.log(`[JOB_TIMING] Starting getBlockTemplate RPC call`);
                return from(this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks)).pipe(
                    tap((blockTemplate) => {
                        const rpcEndTime = Date.now();
                        console.log(`[JOB_TIMING] getBlockTemplate RPC completed: ${rpcEndTime - rpcStartTime}ms`);
                    }),
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
                console.log(`[JOB_TIMING] Template processing step 1 completed: ${Date.now() - processingStartTime}ms`);
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
                const blockBuildTime = Date.now() - blockBuildStartTime;
                console.log(`[JOB_TIMING] Block building (merkle, transactions, etc): ${blockBuildTime}ms`);

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

    public cleanup(clearJobs: boolean, now: number = Date.now()) {
        if (clearJobs) {
            this.blocks = {};
            this.jobs = {};
            return;
        }

        for (const templateId in this.blocks) {
            if (now - this.blocks[templateId].blockData.creation > this.job_retention_ms) {
                delete this.blocks[templateId];
            }
        }

        for (const jobId in this.jobs) {
            if (now - this.jobs[jobId].creation > this.job_retention_ms) {
                delete this.jobs[jobId];
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

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }


}
