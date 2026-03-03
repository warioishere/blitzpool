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
}
