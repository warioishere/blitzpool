/**
 * Unit tests for `StratumV1JobsService` lifecycle (ckpool-style):
 *   current → retired (kept queryable) → aged-out (only after retention).
 *
 * Covers:
 *   - cleanup(true) stamps retiredAt on all current entries without
 *     deleting them
 *   - cleanup is idempotent: a second cleanup(true) doesn't bump
 *     retiredAt on already-retired entries
 *   - aging respects MIN_RETAINED (3): never deletes the newest 3
 *     entries regardless of age
 *   - aging only deletes entries with retiredAt set AND past the
 *     retention window
 *   - aging falls back to absolute creation-age (defense-in-depth)
 *     for non-retired entries that somehow piled up past 2× retention
 *   - classifyJobForShare returns 'active' / 'stale-creditable' /
 *     'stale-rejected' based on retirement age and STALE_GRACE_MS
 */

import { StratumV1JobsService, IJobTemplate, STALE_GRACE_MS } from './stratum-v1-jobs.service';
import { MiningJob } from '../models/MiningJob';

// Tiny factory: an IJobTemplate just deep-enough to exercise cleanup().
// We don't need a real bitcoinjs.Block or merkle branches — cleanup only
// reads `blockData.creation` and `blockData.retiredAt`.
function makeTemplate(id: string, creation: number, retiredAt?: number): IJobTemplate {
  return {
    block: null as any,
    merkle_branch: [],
    blockData: {
      id,
      creation,
      coinbasevalue: 0,
      networkDifficulty: 1,
      height: 1,
      clearJobs: false,
      retiredAt,
    },
  };
}

// MiningJob factory — only the fields cleanup/classifyJobForShare touch.
function makeJob(jobId: string, creation: number, retiredAt?: number): MiningJob {
  const job = Object.create(MiningJob.prototype) as MiningJob;
  (job as any).jobId = jobId;
  (job as any).creation = creation;
  (job as any).retiredAt = retiredAt;
  (job as any).jobTemplateId = 'tmpl-' + jobId;
  return job;
}

function makeService(): StratumV1JobsService {
  // Construct without going through the RxJS pipeline — we test cleanup
  // and classifyJobForShare in isolation. The `bitcoinRpcService`
  // dependency is unused by the methods under test; pass a stub.
  const stub = { newBlock$: { pipe: () => ({}) } } as any;
  const service = new StratumV1JobsService(stub);
  return service;
}

describe('StratumV1JobsService — cleanup() lifecycle', () => {

  describe('cleanup(true) on block change — retire, do NOT delete', () => {
    it('stamps retiredAt on all current jobs and templates', () => {
      const service = makeService();
      const now = 1_000_000;

      service.blocks['t1'] = makeTemplate('t1', now - 30_000);
      service.blocks['t2'] = makeTemplate('t2', now - 10_000);
      service.jobs['j1'] = makeJob('j1', now - 30_000);
      service.jobs['j2'] = makeJob('j2', now - 10_000);

      service.cleanup(true, now);

      // Nothing deleted.
      expect(Object.keys(service.blocks)).toEqual(['t1', 't2']);
      expect(Object.keys(service.jobs)).toEqual(['j1', 'j2']);

      // All retiredAt stamped.
      expect(service.blocks['t1'].blockData.retiredAt).toBe(now);
      expect(service.blocks['t2'].blockData.retiredAt).toBe(now);
      expect(service.jobs['j1'].retiredAt).toBe(now);
      expect(service.jobs['j2'].retiredAt).toBe(now);
    });

    it('is idempotent: a second cleanup(true) keeps the original retiredAt', () => {
      const service = makeService();
      const t0 = 1_000_000;
      const t1 = 1_005_000;

      service.jobs['j1'] = makeJob('j1', t0 - 10_000);
      service.cleanup(true, t0);
      expect(service.jobs['j1'].retiredAt).toBe(t0);

      service.cleanup(true, t1);
      // Still stamped at t0 — already-retired entries don't get bumped.
      expect(service.jobs['j1'].retiredAt).toBe(t0);
    });
  });

  describe('cleanup(false) — periodic aging', () => {
    it('respects MIN_RETAINED=3: never deletes the newest 3 entries', () => {
      const service = makeService();
      const now = 1_000_000_000;
      // 5 retired, all far past retention. With MIN_RETAINED=3 only the
      // oldest 2 should be deletable.
      const retentionMs = (service as any).job_retention_ms as number;
      for (let i = 0; i < 5; i++) {
        const id = `t${i}`;
        const creation = now - (5 - i) * 1_000_000;
        const retiredAt = creation; // retired right at creation
        service.blocks[id] = makeTemplate(id, creation, retiredAt);
      }

      service.cleanup(false, now + retentionMs * 2);

      // The 3 newest (t2, t3, t4) survive regardless of age.
      expect(Object.keys(service.blocks).sort()).toEqual(['t2', 't3', 't4']);
    });

    it('only deletes retired entries past the retention window', () => {
      const service = makeService();
      const now = 2_000_000;
      const retentionMs = (service as any).job_retention_ms as number;

      // 4 entries — 2 retired-and-old, 2 retired-but-fresh.
      service.jobs['old1'] = makeJob('old1', now - retentionMs - 10_000, now - retentionMs - 10_000);
      service.jobs['old2'] = makeJob('old2', now - retentionMs - 5_000,  now - retentionMs - 5_000);
      service.jobs['fresh1'] = makeJob('fresh1', now - 30_000, now - 30_000);
      service.jobs['fresh2'] = makeJob('fresh2', now - 10_000, now - 10_000);

      service.cleanup(false, now);

      // The fresh ones survive. With MIN_RETAINED=3, only ONE old entry
      // can be deleted (older one — sort by creation desc, slice 3).
      // Verify at least the older-of-two-old got deleted, and the fresh
      // ones are untouched.
      expect(service.jobs['fresh1']).toBeDefined();
      expect(service.jobs['fresh2']).toBeDefined();
      // 'old1' is the oldest → first GC candidate after MIN_RETAINED slice.
      expect(service.jobs['old1']).toBeUndefined();
    });

    it('keeps non-retired entries alive even if older than retention', () => {
      const service = makeService();
      const now = 5_000_000;
      const retentionMs = (service as any).job_retention_ms as number;

      // Many non-retired entries (defense-in-depth: only delete if past
      // 2× retention). Within 1× retention they all survive.
      for (let i = 0; i < 5; i++) {
        const id = `j${i}`;
        service.jobs[id] = makeJob(id, now - retentionMs - 1_000); // 1× retention old
      }

      service.cleanup(false, now);

      // None deleted — non-retired entries below the 2× hard cap.
      expect(Object.keys(service.jobs).sort()).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
    });

    it('defense-in-depth: deletes non-retired entries past 2× retention', () => {
      const service = makeService();
      const now = 10_000_000;
      const retentionMs = (service as any).job_retention_ms as number;

      // 5 non-retired entries, all WAY past 2× retention. With
      // MIN_RETAINED=3, the 2 oldest are eligible.
      for (let i = 0; i < 5; i++) {
        const id = `j${i}`;
        const creation = now - (retentionMs * 3) - i * 1000;
        service.jobs[id] = makeJob(id, creation);
      }

      service.cleanup(false, now);

      // Newest 3 survive.
      expect(Object.keys(service.jobs).length).toBe(3);
    });
  });

  describe('classifyJobForShare', () => {
    const service = makeService();

    it("returns 'active' for a non-retired job", () => {
      const job = makeJob('j1', 1_000_000);
      expect(service.classifyJobForShare(job, 1_005_000)).toBe('active');
    });

    it("returns 'stale-creditable' within STALE_GRACE_MS of retirement", () => {
      const retiredAt = 1_000_000;
      const job = makeJob('j1', retiredAt - 30_000, retiredAt);

      // Right at retirement
      expect(service.classifyJobForShare(job, retiredAt)).toBe('stale-creditable');
      // Just before grace expires
      expect(service.classifyJobForShare(job, retiredAt + STALE_GRACE_MS - 1)).toBe('stale-creditable');
      // At exactly grace boundary — still creditable (≤)
      expect(service.classifyJobForShare(job, retiredAt + STALE_GRACE_MS)).toBe('stale-creditable');
    });

    it("returns 'stale-rejected' beyond STALE_GRACE_MS", () => {
      const retiredAt = 1_000_000;
      const job = makeJob('j1', retiredAt - 30_000, retiredAt);

      // 1ms past grace
      expect(service.classifyJobForShare(job, retiredAt + STALE_GRACE_MS + 1)).toBe('stale-rejected');
      // Way past grace
      expect(service.classifyJobForShare(job, retiredAt + 60_000)).toBe('stale-rejected');
    });
  });

  describe('end-to-end lifecycle: current → retired → aged-out', () => {
    it('a job retired at t0 is still queryable until t0 + retention, then GC\'d', () => {
      const service = makeService();
      const t0 = 1_000_000_000;
      const retentionMs = (service as any).job_retention_ms as number;

      // Phase 1: active
      service.jobs['j1'] = makeJob('j1', t0 - 10_000);
      service.jobs['j2'] = makeJob('j2', t0 - 5_000);
      service.jobs['j3'] = makeJob('j3', t0 - 1_000);
      service.jobs['j4'] = makeJob('j4', t0 - 500);
      expect(service.classifyJobForShare(service.jobs['j1'], t0)).toBe('active');

      // Phase 2: block change at t0 → all retired, none deleted
      service.cleanup(true, t0);
      expect(service.jobs['j1']).toBeDefined();
      expect(service.jobs['j1'].retiredAt).toBe(t0);

      // Phase 3: a share arrives within grace → still creditable
      expect(service.classifyJobForShare(service.jobs['j1'], t0 + 1_000))
        .toBe('stale-creditable');

      // Phase 4: a share arrives well after grace, before retention → rejected stale
      expect(service.classifyJobForShare(service.jobs['j1'], t0 + 30_000))
        .toBe('stale-rejected');
      // BUT the job is still in the map for accurate stat classification:
      expect(service.jobs['j1']).toBeDefined();

      // Phase 5: aging fires after retention window → j1 GC'd (oldest);
      // newest 3 survive (MIN_RETAINED).
      service.cleanup(false, t0 + retentionMs + 1);
      expect(service.jobs['j1']).toBeUndefined();
      expect(service.jobs['j2']).toBeDefined();
      expect(service.jobs['j3']).toBeDefined();
      expect(service.jobs['j4']).toBeDefined();
    });
  });
});
