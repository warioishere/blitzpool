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
}
