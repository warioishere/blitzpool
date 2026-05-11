import { PoolShareStatisticsService } from './pool-share-statistics.service';
import { MAX_REASONABLE_DIFFICULTY } from '../../constants/mining.constants';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

describe('PoolShareStatisticsService (in-memory)', () => {
  let service: PoolShareStatisticsService;

  beforeEach(() => {
    service = new PoolShareStatisticsService({} as any);
  });

  describe('addAcceptedShare / addRejectedShare', () => {
    it('accumulates accepted diff under the current slot', () => {
      const slot = TimeSlotHelper.getCurrentSlot();
      service.addAcceptedShare(10);
      service.addAcceptedShare(5);

      const drained = service.drainSlotDeltas();
      expect(drained.get(slot)).toEqual({ accepted: 15, rejected: 0 });
    });

    it('accumulates rejected diff under the current slot', () => {
      const slot = TimeSlotHelper.getCurrentSlot();
      service.addRejectedShare(7);

      const drained = service.drainSlotDeltas();
      expect(drained.get(slot)).toEqual({ accepted: 0, rejected: 7 });
    });

    it('keeps accepted and rejected on the same slot bucket', () => {
      const slot = TimeSlotHelper.getCurrentSlot();
      service.addAcceptedShare(10);
      service.addRejectedShare(2);

      const drained = service.drainSlotDeltas();
      expect(drained.get(slot)).toEqual({ accepted: 10, rejected: 2 });
    });

    it('discards non-finite values', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      try {
        service.addAcceptedShare(NaN);
        service.addAcceptedShare(Infinity);
        service.addRejectedShare(-Infinity);
        expect(service.drainSlotDeltas().size).toBe(0);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('discards out-of-range diffs that would overflow PG real column', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      try {
        // Reproduces the production incident on 2026-05-01: a buggy SV2
        // client opened a channel with absurdly small maxTarget, getting
        // assigned a per-share diff in the e+50 range. Postgres `real`
        // (max ~3.4e38) refuses the value on flush and the bucket gets
        // stuck for every subsequent share. Discard at write time.
        service.addAcceptedShare(9.8e53);
        expect(service.drainSlotDeltas().size).toBe(0);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('accepts values up to MAX_REASONABLE_DIFFICULTY', () => {
      service.addAcceptedShare(MAX_REASONABLE_DIFFICULTY);
      expect(service.drainSlotDeltas().size).toBe(1);
    });

    it('skips zero / negative values without recording a bucket', () => {
      service.addAcceptedShare(0);
      service.addAcceptedShare(-5);
      service.addRejectedShare(0);

      expect(service.drainSlotDeltas().size).toBe(0);
    });
  });

  describe('drain / confirm', () => {
    it('drainSlotDeltas does NOT clear state; confirm is required', () => {
      service.addAcceptedShare(10);
      service.drainSlotDeltas();
      const again = service.drainSlotDeltas();
      expect(again.size).toBe(1);
    });

    it('confirmFlush subtracts the flushed amounts; residuals stay', () => {
      const slot = TimeSlotHelper.getCurrentSlot();
      service.addAcceptedShare(10);
      const snapshot = service.drainSlotDeltas();

      // A share arrives during the simulated PG await:
      service.addAcceptedShare(4);

      service.confirmFlush(snapshot);
      expect(service.drainSlotDeltas().get(slot)).toEqual({ accepted: 4, rejected: 0 });
    });

    it('confirmFlush removes the slot entry when nothing remains', () => {
      service.addAcceptedShare(10);
      const snapshot = service.drainSlotDeltas();
      service.confirmFlush(snapshot);
      expect(service.drainSlotDeltas().size).toBe(0);
    });
  });
});
