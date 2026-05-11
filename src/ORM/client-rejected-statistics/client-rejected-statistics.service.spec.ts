import { ClientRejectedStatisticsService } from './client-rejected-statistics.service';
import { TimeSlotHelper } from '../../utils/time-slot.helper';

describe('ClientRejectedStatisticsService (in-memory)', () => {
  let service: ClientRejectedStatisticsService;

  beforeEach(() => {
    service = new ClientRejectedStatisticsService({} as any);
  });

  describe('addRejectedShare', () => {
    it('records count and shares per (address, slot, reason)', () => {
      const slot = TimeSlotHelper.getCurrentSlot();
      service.addRejectedShare('addr', 'duplicate', 5);

      const drained = service.drainDeltas();
      expect(drained).toEqual([
        { address: 'addr', time: slot, reason: 'duplicate', count: 1, shares: 4 },
      ]);
    });

    it('accumulates across multiple calls with the same (addr, slot, reason)', () => {
      service.addRejectedShare('addr', 'duplicate', 5);
      service.addRejectedShare('addr', 'duplicate', 3);

      const drained = service.drainDeltas();
      expect(drained).toEqual([
        expect.objectContaining({ address: 'addr', reason: 'duplicate', count: 2, shares: 6 }),
      ]);
    });

    it('keeps reasons separate within the same address+slot', () => {
      service.addRejectedShare('addr', 'duplicate', 5);
      service.addRejectedShare('addr', 'low-diff', 3);

      const drained = service.drainDeltas();
      expect(drained).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'duplicate', count: 1, shares: 4 }),
        expect.objectContaining({ reason: 'low-diff', count: 1, shares: 2 }),
      ]));
    });

    it('discards calls with empty address or reason or non-finite diff', () => {
      service.addRejectedShare('', 'duplicate', 5);
      service.addRejectedShare('addr', '', 5);
      service.addRejectedShare('addr', 'duplicate', NaN);
      service.addRejectedShare('addr', 'duplicate', Infinity);

      expect(service.drainDeltas()).toEqual([]);
    });
  });

  describe('drain / confirm', () => {
    it('confirmFlush subtracts only the flushed amounts; residuals stay', () => {
      service.addRejectedShare('addr', 'duplicate', 5);
      const snapshot = service.drainDeltas();
      // A reject arrives during the simulated PG await:
      service.addRejectedShare('addr', 'duplicate', 3);

      service.confirmFlush(snapshot);

      const after = service.drainDeltas();
      expect(after).toEqual([
        expect.objectContaining({ address: 'addr', reason: 'duplicate', count: 1, shares: 2 }),
      ]);
    });

    it('confirmFlush removes the entry when both count and shares hit 0', () => {
      service.addRejectedShare('addr', 'duplicate', 5);
      const snapshot = service.drainDeltas();
      service.confirmFlush(snapshot);
      expect(service.drainDeltas()).toEqual([]);
    });
  });

  describe('clearRedisKeysForAddress (legacy name; now in-memory)', () => {
    it('drops all entries for the given address', async () => {
      service.addRejectedShare('addr1', 'duplicate', 5);
      service.addRejectedShare('addr2', 'duplicate', 5);

      await service.clearRedisKeysForAddress('addr1');

      const drained = service.drainDeltas();
      expect(drained).toEqual([
        expect.objectContaining({ address: 'addr2' }),
      ]);
    });

    it('is a no-op when there is nothing to drop', async () => {
      await service.clearRedisKeysForAddress('nonexistent');
      expect(service.drainDeltas()).toEqual([]);
    });
  });
});
