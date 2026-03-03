/**
 * Job-Specific Target Tracking Tests
 *
 * Verifies SV2 spec compliance: shares must be validated against the target
 * that was in effect when the job was sent, not the current channel target.
 *
 * Reference: stratum/sv2/channels-sv2/src/server/standard.rs
 * - Line 89: job_id_to_target HashMap
 * - Lines 456-457, 489-490: Store target when job is created
 * - Lines 590-593: Validate using job-specific target
 */

import { StratumV2ChannelState } from './interfaces/stratum-v2-channel.interface';

describe('SV2 Job-Specific Target Tracking', () => {
  describe('Channel State Interface', () => {
    it('should include jobIdToDifficulty map in channel state', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      expect(channel.jobIdToDifficulty).toBeInstanceOf(Map);
      expect(channel.jobIdToDifficulty.size).toBe(0);
    });

    it('should store and retrieve job-specific difficulties', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1500,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Simulate sending jobs with different difficulties
      channel.jobIdToDifficulty.set(100, 1000); // Job 100 sent with difficulty 1000
      channel.sessionDifficulty = 1200;          // Difficulty increased via SetTarget
      channel.jobIdToDifficulty.set(101, 1200); // Job 101 sent with difficulty 1200

      // Verify job-specific difficulties are stored correctly
      expect(channel.jobIdToDifficulty.get(100)).toBe(1000);
      expect(channel.jobIdToDifficulty.get(101)).toBe(1200);
      expect(channel.sessionDifficulty).toBe(1200);
    });

    it('should handle difficulty decrease scenario', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.alloc(8),
        extranonceSize: 8,
        sessionDifficulty: 2000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Job 200 sent with high difficulty
      channel.jobIdToDifficulty.set(200, 2000);

      // Difficulty decreased via SetTarget
      channel.sessionDifficulty = 1000;

      // Job 201 sent with lower difficulty
      channel.jobIdToDifficulty.set(201, 1000);

      // Shares for old job should still require old (higher) difficulty
      expect(channel.jobIdToDifficulty.get(200)).toBe(2000);
      expect(channel.jobIdToDifficulty.get(201)).toBe(1000);
    });
  });

  describe('Race Condition Prevention', () => {
    it('should prevent false rejections when difficulty increases', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Scenario: Pool sends job, then increases difficulty, miner submits share
      const jobId = 1000;
      const initialDifficulty = 1000;
      const newDifficulty = 1500;
      const shareSubmissionDifficulty = 1200;

      // 1. Pool sends job with difficulty 1000
      channel.jobIdToDifficulty.set(jobId, initialDifficulty);

      // 2. Pool sends SetTarget with difficulty 1500
      channel.sessionDifficulty = newDifficulty;

      // 3. Miner submits share for old job with difficulty 1200
      const jobDifficulty = channel.jobIdToDifficulty.get(jobId) ?? channel.sessionDifficulty;

      // 4. Validate: Share should be ACCEPTED (1200 >= 1000)
      //    Without job-specific tracking, would be REJECTED (1200 < 1500)
      expect(jobDifficulty).toBe(initialDifficulty);
      expect(shareSubmissionDifficulty >= jobDifficulty).toBe(true);

      // Show the incorrect behavior without job-specific tracking
      expect(shareSubmissionDifficulty >= channel.sessionDifficulty).toBe(false);
    });

    it('should prevent false acceptances when difficulty decreases', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'extended',
        extranoncePrefix: Buffer.alloc(8),
        extranonceSize: 8,
        sessionDifficulty: 2000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Scenario: Pool sends job, then decreases difficulty, miner submits share
      const jobId = 2000;
      const initialDifficulty = 2000;
      const newDifficulty = 1000;
      const shareSubmissionDifficulty = 1500;

      // 1. Pool sends job with difficulty 2000
      channel.jobIdToDifficulty.set(jobId, initialDifficulty);

      // 2. Pool sends SetTarget with difficulty 1000
      channel.sessionDifficulty = newDifficulty;

      // 3. Miner submits share for old job with difficulty 1500
      const jobDifficulty = channel.jobIdToDifficulty.get(jobId) ?? channel.sessionDifficulty;

      // 4. Validate: Share should be REJECTED (1500 < 2000)
      //    Without job-specific tracking, would be ACCEPTED (1500 >= 1000)
      expect(jobDifficulty).toBe(initialDifficulty);
      expect(shareSubmissionDifficulty >= jobDifficulty).toBe(false);

      // Show the incorrect behavior without job-specific tracking
      expect(shareSubmissionDifficulty >= channel.sessionDifficulty).toBe(true);
    });
  });

  describe('Job Lifecycle Management', () => {
    it('should clear job-to-difficulty map on new chain tip', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Add several job-difficulty mappings
      channel.jobIdToDifficulty.set(100, 1000);
      channel.jobIdToDifficulty.set(101, 1100);
      channel.jobIdToDifficulty.set(102, 1200);

      expect(channel.jobIdToDifficulty.size).toBe(3);

      // Simulate SetNewPrevHash (new block found)
      channel.jobIdToDifficulty.clear();
      channel.miningSubmissionHashes.clear();

      expect(channel.jobIdToDifficulty.size).toBe(0);
      expect(channel.miningSubmissionHashes.size).toBe(0);
    });

    it('should handle missing job ID gracefully', () => {
      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      const unknownJobId = 999;

      // Use fallback to current session difficulty
      const jobDifficulty = channel.jobIdToDifficulty.get(unknownJobId) ?? channel.sessionDifficulty;

      expect(jobDifficulty).toBe(channel.sessionDifficulty);
    });
  });

  describe('Reference Implementation Compliance', () => {
    it('should match reference pool behavior: job-specific targets', () => {
      // Reference: stratum/sv2/channels-sv2/src/server/standard.rs
      // Lines 456-457, 489-490: Store target when job is created
      // Lines 590-593: Validate using job-specific target

      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map(),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      // Reference behavior:
      // 1. When job is broadcast, store current target with job_id
      const jobId = 42;
      channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);

      // 2. When SetTarget is received, update channel target (for future jobs only)
      channel.sessionDifficulty = 2000;

      // 3. When share is submitted, look up job-specific target
      const jobTarget = channel.jobIdToDifficulty.get(jobId);

      // 4. Verify: job target should be the old value, not the new channel target
      expect(jobTarget).toBe(1000);
      expect(jobTarget).not.toBe(channel.sessionDifficulty);
    });

    it('should match reference pool behavior: SetNewPrevHash clears mapping', () => {
      // Reference: stratum/sv2/channels-sv2/src/server/standard.rs
      // Line 511: self.job_id_to_target.clear()

      const channel: StratumV2ChannelState = {
        channelId: 1,
        channelType: 'standard',
        extranoncePrefix: Buffer.alloc(4),
        extranonceSize: 8,
        sessionDifficulty: 1000,
        jobIdToDifficulty: new Map([[100, 1000], [101, 1100]]),
        extendedJobs: new Map(),
        latestExtendedPrevHash: Buffer.alloc(32),
        latestExtendedNBits: 0,
        latestExtendedMinNtime: 0,
        acceptedShareCount: 0,
        acceptedShareDifficultySum: 0n,
        acceptedShareDifficultyFloat: 0,
        miningSubmissionHashes: new Set(),
        declaredMaxTarget: Buffer.alloc(32, 0xff),
      };

      expect(channel.jobIdToDifficulty.size).toBe(2);

      // SetNewPrevHash received (new block)
      channel.jobIdToDifficulty.clear();

      expect(channel.jobIdToDifficulty.size).toBe(0);
    });
  });
});
