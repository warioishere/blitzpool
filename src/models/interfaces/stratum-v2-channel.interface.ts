import type { IJobTemplate } from '../../services/stratum-v1-jobs.service';
import type { MiningJob } from '../MiningJob';

export interface ExtendedJobData {
  coinbasePrefix: Buffer;
  coinbaseSuffix: Buffer;
  merklePath: Buffer[];
  version: number;
  prevHash: Buffer;
  nBits: number;
  minNtime: number;
  jobTemplate: IJobTemplate | null;
  miningJob?: MiningJob;

  /**
   * Wall-clock ms when this extended job was superseded by a newer block.
   * Pre-refactor the channel's `extendedJobs` map was wiped via
   * `extendedJobs.clear()` on every `clearJobs=true`, BEFORE the new job
   * was broadcast — opening the same race window that the central service
   * had (a miner submits a share against the just-cleared old job and
   * gets `invalid-job-id`). The new pattern: stamp `retiredAt` on every
   * existing entry; subscribers can still resolve their old jobId,
   * classification distinguishes stale from genuinely-missing per SV2
   * spec §5.3.14 (`stale-share` vs `invalid-job-id`).
   *
   * Aged out by `cleanupRetiredExtendedJobs()` after JOB_RETENTION_MS.
   */
  retiredAt?: number;

  /**
   * Wall-clock ms of original creation. Used by the aging path to
   * defense-in-depth-evict any non-retired entries that pile up past
   * 2× retention (clock-jump or missed retire signal).
   */
  creation: number;
}

export interface StratumV2ChannelState {
  channelId: number;
  channelType: 'standard' | 'extended';
  extranoncePrefix: Buffer;
  extranonceSize: number;
  sessionDifficulty: number;
  jobIdToDifficulty: Map<number, number>;  // Tracks difficulty for each job (SV2 spec: shares validated against job-specific target)
  /**
   * Standard channels only. The merkle root sent to the miner in NewMiningJob
   * is stored verbatim per jobId so share validation hashes the exact same
   * 80-byte header the miner did. Replaces the previous design that
   * recomputed merkleRoot via MiningJob.applyExtranonceAndGetCoinbaseHash —
   * which mutated the MiningJob's coinbase script buffer in place and broke
   * for BraiinsOS Standard channels under message-ordering edge cases.
   * SRI reference pattern (channels-sv2/src/server/standard.rs:595).
   * Extended channels reconstruct merkleRoot on submit from ExtendedJobData
   * + miner-supplied extranonce — that path already avoids mutation.
   */
  jobIdToMerkleRoot: Map<number, Buffer>;
  extendedJobs: Map<number, ExtendedJobData>;
  latestExtendedPrevHash: Buffer;
  latestExtendedNBits: number;
  latestExtendedMinNtime: number;
  acceptedShareCount: number;
  acceptedShareDifficultySum: bigint;
  acceptedShareDifficultyFloat: number;  // Float accumulator for sub-1 difficulties
  miningSubmissionHashes: Set<string>;
  declaredMaxTarget: Buffer;  // SV2 spec: client's declared maximum target — pool must not assign easier targets
  isJdClient?: boolean; // JD clients manage their own jobs via Job Declaration Protocol
  firstShareLogged?: boolean; // One-shot flag for logging actual extranonce length on first share

  /**
   * Signature of the last mining job actually sent on this channel
   * (version + prev_hash + nBits + coinbase prefix/suffix + merkle path,
   * or merkle root for standard channels). A periodic template refresh that
   * produces byte-identical work is suppressed instead of re-issued under a
   * fresh jobId — a new jobId for unchanged work makes firmware (e.g. Bitaxe)
   * reset its extranonce search and re-mine the identical header, freezing
   * session best-difficulty. Reset implicitly on a real block change, which
   * always carries a new prev_hash → new signature → never suppressed.
   */
  lastSentJobSignature?: string;
}
