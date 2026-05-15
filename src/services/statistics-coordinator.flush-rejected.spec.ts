import { DataSource } from 'typeorm';

jest.mock('node-telegram-bot-api', () => ({}));

import { StatisticsCoordinatorService } from './statistics-coordinator.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';

/**
 * The `flushClientStatistics` method now drains the in-memory
 * ClientStatisticsService and fans rejected-difficulty totals into
 * worker_shares_entity via WorkerSharesService.addRejectedBulk. These
 * tests pin that per-worker rejected-diff accounting end-to-end.
 */
const SLOT = 1700000060000;

function buildService(
    mockWorkerShares: Partial<WorkerSharesService>,
    drainedClientDeltas: any[],
    clientConfirmFlush: jest.Mock = jest.fn(),
) {
    const service = new StatisticsCoordinatorService(
        { store: {} } as any,           // cacheManager — no Redis store so onModuleInit is skipped
        {} as any,                       // poolShareStatisticsRepository
        {} as any,                       // poolRejectedStatisticsRepository
        {} as any,                       // poolModeHashrateRepository
        {} as any,                       // clientStatisticsRepository
        {} as any,                       // clientRejectedStatisticsRepository
        { options: { type: 'postgres' }, query: jest.fn() } as unknown as DataSource,
        {} as any,                       // addressSettingsService
        mockWorkerShares as WorkerSharesService,
        {
            drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
            drainWorkerDeltas: jest.fn().mockReturnValue([]),
            confirmAddressFlush: jest.fn(),
            confirmWorkerFlush: jest.fn(),
        } as any,                        // shareTotalsCache
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                        // poolModeHashrateService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                        // poolShareStatisticsService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                        // poolRejectedStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue(drainedClientDeltas),
            confirmFlush: clientConfirmFlush,
        } as any,                        // clientStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                        // clientRejectedStatisticsService
    );
    // Stub the bulk upsert path since these specs are about the fan-out.
    jest.spyOn(service as any, 'bulkUpsertClientStatistics').mockResolvedValue(undefined);
    return service;
}

describe('StatisticsCoordinatorService – flushClientStatistics → worker_shares fan-out', () => {
    let mockWorkerShares: { addRejectedBulk: jest.Mock };

    beforeEach(() => {
        mockWorkerShares = { addRejectedBulk: jest.fn().mockResolvedValue(undefined) };
    });

    it('accumulates per-worker rejected diff totals across sessions and calls addRejectedBulk', async () => {
        const drained = [
            // rig1 session 1: jobNotFound=3, duplicate=1, lowDiff=1 → 5
            { address: 'addr1', clientName: 'rig1', sessionId: 'sess1', time: SLOT,
              shares: 100, acceptedCount: 10, rejectedCount: 3,
              rejectedJobNotFoundCount: 1, rejectedJobNotFoundDiff1: 3,
              rejectedDuplicateShareCount: 1, rejectedDuplicateShareDiff1: 1,
              rejectedLowDifficultyShareCount: 1, rejectedLowDifficultyShareDiff1: 1 },
            // rig1 session 2: jobNotFound=2 → 2
            { address: 'addr1', clientName: 'rig1', sessionId: 'sess2', time: SLOT + 60000,
              shares: 50, acceptedCount: 5, rejectedCount: 2,
              rejectedJobNotFoundCount: 2, rejectedJobNotFoundDiff1: 2,
              rejectedDuplicateShareCount: 0, rejectedDuplicateShareDiff1: 0,
              rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0 },
            // rig2: duplicate=4 → 4
            { address: 'addr1', clientName: 'rig2', sessionId: 'sess1', time: SLOT,
              shares: 200, acceptedCount: 20, rejectedCount: 4,
              rejectedJobNotFoundCount: 0, rejectedJobNotFoundDiff1: 0,
              rejectedDuplicateShareCount: 4, rejectedDuplicateShareDiff1: 4,
              rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0 },
        ];

        const service = buildService(mockWorkerShares, drained);
        await (service as any).flushClientStatistics();

        expect(mockWorkerShares.addRejectedBulk).toHaveBeenCalledTimes(1);
        const [addresses, clientNames, rejectedShares] = mockWorkerShares.addRejectedBulk.mock.calls[0];
        // Find each rig by clientName and check its (address, rejectedShares).
        const rig1Idx = clientNames.indexOf('rig1');
        const rig2Idx = clientNames.indexOf('rig2');
        // rig1: session1(5) + session2(2) = 7
        expect(addresses[rig1Idx]).toBe('addr1');
        expect(rejectedShares[rig1Idx]).toBe(7);
        // rig2: 4
        expect(addresses[rig2Idx]).toBe('addr1');
        expect(rejectedShares[rig2Idx]).toBe(4);
    });

    it('does not call addRejectedBulk when all rejected totals are zero', async () => {
        const drained = [
            { address: 'addr1', clientName: 'rig1', sessionId: 'sess1', time: SLOT,
              shares: 100, acceptedCount: 10, rejectedCount: 0,
              rejectedJobNotFoundCount: 0, rejectedJobNotFoundDiff1: 0,
              rejectedDuplicateShareCount: 0, rejectedDuplicateShareDiff1: 0,
              rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0 },
        ];
        const service = buildService(mockWorkerShares, drained);
        await (service as any).flushClientStatistics();
        expect(mockWorkerShares.addRejectedBulk).not.toHaveBeenCalled();
    });

    it('does not confirm the flush when the DB upsert fails', async () => {
        const drained = [
            { address: 'addr1', clientName: 'rig1', sessionId: 'sess1', time: SLOT,
              shares: 100, acceptedCount: 10, rejectedCount: 2,
              rejectedJobNotFoundCount: 2, rejectedJobNotFoundDiff1: 5,
              rejectedDuplicateShareCount: 0, rejectedDuplicateShareDiff1: 0,
              rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0 },
        ];
        const confirmFlush = jest.fn();
        const service = buildService(mockWorkerShares, drained, confirmFlush);
        // Override the spy on bulkUpsertClientStatistics to make it fail.
        jest.spyOn(service as any, 'bulkUpsertClientStatistics').mockRejectedValue(new Error('DB error'));

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
        try {
            await (service as any).flushClientStatistics();
        } finally {
            consoleSpy.mockRestore();
        }

        // confirm is only called for successful batches — none succeeded, so 0.
        expect(confirmFlush).not.toHaveBeenCalled();
    });

    it('does not call addRejectedBulk when there are no drained deltas', async () => {
        const service = buildService(mockWorkerShares, []);
        await (service as any).flushClientStatistics();
        expect(mockWorkerShares.addRejectedBulk).not.toHaveBeenCalled();
    });
});
