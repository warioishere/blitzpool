import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';

describe('ShareTotalsCacheService', () => {
  let addressSettingsService: {
    getSettings: jest.Mock;
  };
  let workerSharesService: {
    getWorkerTotals: jest.Mock;
  };
  let service: ShareTotalsCacheService;

  beforeEach(() => {
    addressSettingsService = {
      getSettings: jest.fn().mockResolvedValue({ shares: 100 }),
    };
    workerSharesService = {
      getWorkerTotals: jest.fn().mockResolvedValue([
        { clientName: 'worker-1', shares: 60 },
        { clientName: 'worker-2', shares: 40 },
      ]),
    };

    service = new ShareTotalsCacheService(
      addressSettingsService as unknown as AddressSettingsService,
      workerSharesService as unknown as WorkerSharesService,
    );
  });

  describe('increment', () => {
    it('accumulates per-address deltas for subsequent flushes', () => {
      service.increment('addr1', 'worker-1', 10);
      service.increment('addr1', 'worker-1', 5);
      service.increment('addr1', 'worker-2', 7);

      const drained = service.drainAddressDeltas();
      expect(drained.get('addr1')).toBe(22);
    });

    it('records per-worker deltas alongside the per-address delta', () => {
      service.increment('addr1', 'worker-1', 10);
      service.increment('addr1', 'worker-2', 5);
      service.increment('addr2', 'worker-1', 8);

      const drained = service.drainWorkerDeltas();
      expect(drained).toEqual(expect.arrayContaining([
        { address: 'addr1', clientName: 'worker-1', shares: 10 },
        { address: 'addr1', clientName: 'worker-2', shares: 5 },
        { address: 'addr2', clientName: 'worker-1', shares: 8 },
      ]));
      expect(drained.length).toBe(3);
    });

    it('ignores empty addresses, zero difficulty and non-finite values', () => {
      service.increment('', 'worker-1', 10);
      service.increment('addr1', 'worker-1', 0);
      service.increment('addr1', 'worker-1', -5);
      service.increment('addr1', 'worker-1', Number.NaN);
      service.increment('addr1', 'worker-1', Number.POSITIVE_INFINITY);

      expect(service.drainAddressDeltas().size).toBe(0);
      expect(service.drainWorkerDeltas().length).toBe(0);
    });

    it('handles undefined workerName by only recording the address delta', () => {
      service.increment('addr1', undefined, 10);

      expect(service.drainAddressDeltas().get('addr1')).toBe(10);
      expect(service.drainWorkerDeltas().length).toBe(0);
    });

    it('keeps worker keys safe when worker names contain colons', () => {
      service.increment('addr1', 'rig:1', 10);
      service.increment('addr1', 'rig:2', 5);

      const drained = service.drainWorkerDeltas();
      expect(drained).toEqual(expect.arrayContaining([
        { address: 'addr1', clientName: 'rig:1', shares: 10 },
        { address: 'addr1', clientName: 'rig:2', shares: 5 },
      ]));
    });
  });

  describe('getAddressTotal', () => {
    it('returns PG total plus in-memory pending delta', async () => {
      service.increment('addr1', 'worker-1', 25);
      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(125); // 100 (PG) + 25 (pending)
    });

    it('returns 0 if neither PG nor cache has data', async () => {
      addressSettingsService.getSettings.mockResolvedValueOnce(null);
      const total = await service.getAddressTotal('unknown');
      expect(total).toBe(0);
    });

    it('returns just the PG total when no pending delta exists', async () => {
      const total = await service.getAddressTotal('addr1');
      expect(total).toBe(100);
    });
  });

  describe('getWorkerTotals', () => {
    it('merges PG worker totals with in-memory deltas', async () => {
      service.increment('addr1', 'worker-1', 5);
      service.increment('addr1', 'worker-3', 12); // not in PG

      const totals = await service.getWorkerTotals('addr1');

      expect(totals).toEqual(expect.arrayContaining([
        { workerName: 'worker-1', total: 65 },
        { workerName: 'worker-2', total: 40 },
        { workerName: 'worker-3', total: 12 },
      ]));
    });

    it('filters out workers with zero total', async () => {
      workerSharesService.getWorkerTotals.mockResolvedValueOnce([
        { clientName: 'worker-1', shares: 0 },
      ]);
      const totals = await service.getWorkerTotals('addr1');
      expect(totals.find(t => t.workerName === 'worker-1')).toBeUndefined();
    });

    it('only counts worker deltas owned by the requested address', async () => {
      service.increment('addr1', 'worker-1', 5);
      service.increment('addr2', 'worker-1', 100);
      workerSharesService.getWorkerTotals.mockResolvedValueOnce([]);

      const totals = await service.getWorkerTotals('addr1');
      expect(totals).toEqual([{ workerName: 'worker-1', total: 5 }]);
    });
  });

  describe('drain / confirm', () => {
    it('confirmAddressFlush removes the flushed delta but preserves residuals', () => {
      service.increment('addr1', 'worker-1', 10);
      const snapshot = service.drainAddressDeltas();
      expect(snapshot.get('addr1')).toBe(10);

      // A new share arrives during the simulated PG await:
      service.increment('addr1', 'worker-1', 4);

      service.confirmAddressFlush(snapshot);

      // The flush removed 10; the 4 that arrived after is preserved:
      const after = service.drainAddressDeltas();
      expect(after.get('addr1')).toBe(4);
    });

    it('confirmWorkerFlush removes flushed worker amounts and preserves residuals', () => {
      service.increment('addr1', 'worker-1', 10);
      const drained = service.drainWorkerDeltas();
      expect(drained).toEqual([{ address: 'addr1', clientName: 'worker-1', shares: 10 }]);

      service.increment('addr1', 'worker-1', 3);
      service.confirmWorkerFlush(drained);

      const after = service.drainWorkerDeltas();
      expect(after).toEqual([{ address: 'addr1', clientName: 'worker-1', shares: 3 }]);
    });

    it('drainAddressDeltas does NOT clear state on its own — confirm is required', () => {
      service.increment('addr1', 'worker-1', 10);
      service.drainAddressDeltas(); // discard return value

      // Still pending until confirm:
      const drainedAgain = service.drainAddressDeltas();
      expect(drainedAgain.get('addr1')).toBe(10);
    });

    it('skips zero and negative deltas from the drain output', () => {
      service.increment('addr1', 'worker-1', 0);
      service.increment('addr2', 'worker-2', 5);

      const drained = service.drainAddressDeltas();
      expect(drained.has('addr1')).toBe(false);
      expect(drained.get('addr2')).toBe(5);
    });
  });

  describe('clearAddressData', () => {
    it('removes the address delta and all of its worker deltas', () => {
      service.increment('addr1', 'worker-1', 10);
      service.increment('addr1', 'worker-2', 5);
      service.increment('addr2', 'worker-1', 8);

      service.clearAddressData('addr1');

      expect(service.drainAddressDeltas().has('addr1')).toBe(false);
      expect(service.drainAddressDeltas().get('addr2')).toBe(8);

      const workers = service.drainWorkerDeltas();
      expect(workers.find(w => w.address === 'addr1')).toBeUndefined();
      expect(workers).toEqual([{ address: 'addr2', clientName: 'worker-1', shares: 8 }]);
    });
  });
});
