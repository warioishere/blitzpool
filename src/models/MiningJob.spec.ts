import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';

import { MiningJob } from './MiningJob';
import { IJobTemplate } from '../services/stratum-v1-jobs.service';

// Synthetic-input equivalence tests for the new fast-path methods on
// MiningJob (`computeShareHeader`, `computeShareMerkleRoot`). The
// invariant we're pinning: for any combination of (versionMask, nonce,
// extraNonce, extraNonce2, timestamp), the new methods produce byte-
// identical output to the existing `copyAndUpdateBlock(...).toBuffer(true)`
// and `copyAndUpdateBlock(...).merkleRoot` respectively.
//
// Why this matters: share validation hashes the 80-byte header buffer.
// If even ONE byte diverges, all shares would be incorrectly rejected
// or accepted. Existing regtests (pplns-, v1-solo-, v2-extended-,
// group-solo-) cover the end-to-end "produced block is accepted by
// bitcoind" path; this spec adds a fast, isolated proof that the new
// hot-path code is bit-for-bit equivalent to the old path.

const NETWORK = bitcoinjs.networks.bitcoin;

function makeConfigService(): any {
    return { get: (k: string) => (k === 'POOL_IDENTIFIER' ? 'spec-pool' : undefined) };
}

/**
 * Build a synthetic jobTemplate that's structurally valid for MiningJob.
 * No real bitcoind needed. A few non-coinbase tx are added so the
 * merkle_branch is non-empty (forces calculateMerkleRootHash to actually
 * walk the branch).
 */
function makeJobTemplate(): IJobTemplate {
    const block = new bitcoinjs.Block();
    block.version = 0x20000000;
    block.prevHash = crypto.randomBytes(32); // LE-ordered (as stored in stratum-v1-jobs.service)
    block.timestamp = 1_700_000_000;
    block.bits = 0x1d00ffff;
    block.merkleRoot = Buffer.alloc(32);
    block.witnessCommit = crypto.randomBytes(32);

    // Placeholder coinbase + 2 random tx so the merkle path has depth.
    const tempCoinbase = new bitcoinjs.Transaction();
    tempCoinbase.version = 2;
    tempCoinbase.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    tempCoinbase.ins[0].witness = [Buffer.alloc(32, 0)];

    const fakeTx1 = new bitcoinjs.Transaction();
    fakeTx1.version = 2;
    fakeTx1.addInput(crypto.randomBytes(32), 0, 0xffffffff);
    fakeTx1.addOutput(Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex'), 1000);

    const fakeTx2 = new bitcoinjs.Transaction();
    fakeTx2.version = 2;
    fakeTx2.addInput(crypto.randomBytes(32), 0, 0xffffffff);
    fakeTx2.addOutput(Buffer.from('76a914' + 'ff'.repeat(20) + '88ac', 'hex'), 2000);

    block.transactions = [tempCoinbase, fakeTx1, fakeTx2];

    // Two-entry merkle branch (random siblings — same shape stratum sends).
    const merkle_branch = [
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex'),
    ];

    return {
        block,
        merkle_branch,
        blockData: {
            id: 'spec-job',
            creation: Date.now(),
            coinbasevalue: 5_000_000_000,
            networkDifficulty: 1,
            height: 100_000,
            clearJobs: true,
        },
    };
}

function makeMiningJob(jobTemplate: IJobTemplate, jobId: string = 'job-0001'): MiningJob {
    return new MiningJob(
        makeConfigService(),
        NETWORK,
        jobId,
        // Canonical valid p2wpkh address (one of the bech32 reference vectors)
        [{ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', percent: 100 }],
        jobTemplate,
    );
}

describe('MiningJob fast-path equivalence', () => {
    // The fast-path methods mutate `this.coinbaseTransaction.ins[0].script`
    // in place (same behaviour as the legacy `copyAndUpdateBlock`). To
    // compare apples-to-apples we need TWO separate MiningJob instances
    // built from the same inputs — one for the new path, one for the old.
    function buildPair(jobTemplate: IJobTemplate): { fresh: MiningJob; legacy: MiningJob } {
        return {
            fresh: makeMiningJob(jobTemplate),
            legacy: makeMiningJob(jobTemplate),
        };
    }

    it('computeShareHeader produces the same 80 bytes as copyAndUpdateBlock(...).toBuffer(true)', () => {
        const jobTemplate = makeJobTemplate();
        const { fresh, legacy } = buildPair(jobTemplate);

        const versionMask = 0x00200000;
        const nonce = 0xdeadbeef;
        const extraNonce = 'aabbccdd';
        const extraNonce2 = '0011223344556677';
        const timestamp = 1_700_000_100;

        const fastHeader = fresh.computeShareHeader(
            jobTemplate, versionMask, nonce, extraNonce, extraNonce2, timestamp,
        );
        const legacyBlock = legacy.copyAndUpdateBlock(
            jobTemplate, versionMask, nonce, extraNonce, extraNonce2, timestamp,
        );
        const legacyHeader = legacyBlock.toBuffer(true);

        expect(fastHeader.length).toBe(80);
        expect(legacyHeader.length).toBe(80);
        expect(fastHeader.equals(legacyHeader)).toBe(true);
    });

    it('computeShareMerkleRoot produces the same 32 bytes as copyAndUpdateBlock(...).merkleRoot', () => {
        const jobTemplate = makeJobTemplate();
        const { fresh, legacy } = buildPair(jobTemplate);

        const extraNonce = '11223344';
        const extraNonce2 = '8877665544332211';

        const fastRoot = fresh.computeShareMerkleRoot(jobTemplate, extraNonce, extraNonce2);
        const legacyBlock = legacy.copyAndUpdateBlock(
            jobTemplate, 0, 0, extraNonce, extraNonce2, jobTemplate.block.timestamp,
        );
        const legacyRoot = legacyBlock.merkleRoot!;

        expect(fastRoot.length).toBe(32);
        expect(legacyRoot.length).toBe(32);
        expect(fastRoot.equals(legacyRoot)).toBe(true);
    });

    it('equivalence holds across many random inputs (200 iterations)', () => {
        const jobTemplate = makeJobTemplate();

        for (let i = 0; i < 200; i++) {
            const { fresh, legacy } = buildPair(jobTemplate);

            const versionMask = crypto.randomInt(0, 0x7fffffff);
            const nonce = crypto.randomInt(0, 0xffffffff);
            const extraNonce = crypto.randomBytes(4).toString('hex');
            const extraNonce2 = crypto.randomBytes(8).toString('hex');
            const timestamp = 1_700_000_000 + crypto.randomInt(0, 1_000_000);

            const fastHeader = fresh.computeShareHeader(
                jobTemplate, versionMask, nonce, extraNonce, extraNonce2, timestamp,
            );
            const legacyHeader = legacy
                .copyAndUpdateBlock(jobTemplate, versionMask, nonce, extraNonce, extraNonce2, timestamp)
                .toBuffer(true);

            expect(fastHeader.equals(legacyHeader)).toBe(true);
        }
    });

    it('versionMask=0 path preserves the original block version (no XOR)', () => {
        const jobTemplate = makeJobTemplate();
        const { fresh, legacy } = buildPair(jobTemplate);

        const fastHeader = fresh.computeShareHeader(jobTemplate, 0, 0, '00000000', '0000000000000000', 1_700_000_000);
        const legacyHeader = legacy
            .copyAndUpdateBlock(jobTemplate, 0, 0, '00000000', '0000000000000000', 1_700_000_000)
            .toBuffer(true);

        // Version is bytes 0..3 LE
        expect(fastHeader.readInt32LE(0)).toBe(jobTemplate.block.version);
        expect(fastHeader.equals(legacyHeader)).toBe(true);
    });

    it('header layout matches Bitcoin wire format (sanity check on field offsets)', () => {
        const jobTemplate = makeJobTemplate();
        const job = makeMiningJob(jobTemplate);

        const version = 0x20000004;
        const versionMask = 0x00400000;
        const nonce = 0x12345678;
        const timestamp = 1_700_005_000;

        // Override the block's version so the XOR result is well-known
        jobTemplate.block.version = version;

        const header = job.computeShareHeader(
            jobTemplate, versionMask, nonce, 'aaaabbbb', '1122334455667788', timestamp,
        );

        expect(header.readInt32LE(0)).toBe(version ^ versionMask);
        expect(jobTemplate.block.prevHash.equals(header.subarray(4, 36))).toBe(true);
        expect(header.readUInt32LE(68)).toBe(timestamp);
        expect(header.readUInt32LE(72)).toBe(jobTemplate.block.bits);
        expect(header.readUInt32LE(76)).toBe(nonce);
    });
});
