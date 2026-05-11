import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { DataSource } from 'typeorm';

jest.mock('node-telegram-bot-api', () => ({}));

import { StatisticsCoordinatorService } from './statistics-coordinator.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';

// A slot in the past so flushClientStatistics does not skip it as "current slot"
const PAST_SLOT = 1700000060000;

function buildService(mockRedis: any, mockWorkerShares: Partial<WorkerSharesService>) {
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
        } as any,                            // poolModeHashrateService
    );
    // Inject Redis directly, bypassing onModuleInit
    (service as any).redisClient = mockRedis;
    return service;
}

describe('StatisticsCoordinatorService – flushClientStatistics rejected accumulation', () => {
    let mockRedis: any;
    let mockWorkerShares: { addRejectedBulk: jest.Mock };

    beforeEach(() => {
        mockWorkerShares = { addRejectedBulk: jest.fn().mockResolvedValue(undefined) };
        // multi() returns a chain that records hGetAll calls and replays
        // the previously-mocked hGetAll responses on .exec(). Mirrors the
        // production node-redis v4 behaviour just enough for the
        // pipelinedHGetAll helper introduced for the flush refactor.
        mockRedis = {
            scan: jest.fn(),
            hGetAll: jest.fn(),
            del: jest.fn().mockResolvedValue(undefined),
            multi: jest.fn(function (this: any) {
                const queued: Array<{ key: string }> = [];
                const chain: any = {
                    hGetAll: (key: string) => { queued.push({ key }); return chain; },
                    exec: async () => {
                        const out: any[] = [];
                        for (const _ of queued) {
                            // Pop the next queued hGetAll mock response.
                            // jest's mockResolvedValueOnce queue is shared
                            // with direct hGetAll calls — fine for tests
                            // that only use one path at a time.
                            const result = await mockRedis.hGetAll();
                            out.push(result);
                        }
                        return out;
                    },
                };
                return chain;
            }),
        };
    });

    function setupScan(keys: string[]) {
        mockRedis.scan.mockResolvedValueOnce({ cursor: 0, keys });
    }

    it('accumulates rejected shares across sessions for the same worker and calls addRejectedBulk', async () => {
        const service = buildService(mockRedis, mockWorkerShares);
        jest.spyOn(service as any, 'bulkUpsertClientStatistics').mockResolvedValue(undefined);

        setupScan([
            `client:shares:addr1:rig1:sess1:${PAST_SLOT}`,
            `client:shares:addr1:rig1:sess2:${PAST_SLOT + 60000}`,
            `client:shares:addr1:rig2:sess1:${PAST_SLOT}`,
        ]);

        // rig1 session 1: jobNotFound=3, duplicate=1, lowDiff=1  → 5
        mockRedis.hGetAll.mockResolvedValueOnce({
            shares: '100', acceptedCount: '10', rejectedCount: '3',
            rejectedJobNotFoundCount: '1', rejectedJobNotFoundDiff1: '3',
            rejectedDuplicateShareCount: '1', rejectedDuplicateShareDiff1: '1',
            rejectedLowDifficultyShareCount: '1', rejectedLowDifficultyShareDiff1: '1',
        });
        // rig1 session 2: jobNotFound=2, duplicate=0, lowDiff=0  → 2
        mockRedis.hGetAll.mockResolvedValueOnce({
            shares: '50', acceptedCount: '5', rejectedCount: '2',
            rejectedJobNotFoundCount: '2', rejectedJobNotFoundDiff1: '2',
            rejectedDuplicateShareCount: '0', rejectedDuplicateShareDiff1: '0',
            rejectedLowDifficultyShareCount: '0', rejectedLowDifficultyShareDiff1: '0',
        });
        // rig2: jobNotFound=0, duplicate=4, lowDiff=0  → 4
        mockRedis.hGetAll.mockResolvedValueOnce({
            shares: '200', acceptedCount: '20', rejectedCount: '4',
            rejectedJobNotFoundCount: '0', rejectedJobNotFoundDiff1: '0',
            rejectedDuplicateShareCount: '4', rejectedDuplicateShareDiff1: '4',
            rejectedLowDifficultyShareCount: '0', rejectedLowDifficultyShareDiff1: '0',
        });

        await (service as any).flushClientStatistics();

        expect(mockWorkerShares.addRejectedBulk).toHaveBeenCalledTimes(1);
        const call = mockWorkerShares.addRejectedBulk.mock.calls[0][0];
        const rig1 = call.find((u: any) => u.clientName === 'rig1');
        const rig2 = call.find((u: any) => u.clientName === 'rig2');

        // rig1: session1(5) + session2(2) = 7
        expect(rig1).toEqual({ address: 'addr1', clientName: 'rig1', rejectedShares: 7 });
        // rig2: 4
        expect(rig2).toEqual({ address: 'addr1', clientName: 'rig2', rejectedShares: 4 });
    });

    it('does not call addRejectedBulk when all rejected totals are zero', async () => {
        const service = buildService(mockRedis, mockWorkerShares);
        jest.spyOn(service as any, 'bulkUpsertClientStatistics').mockResolvedValue(undefined);

        setupScan([`client:shares:addr1:rig1:sess1:${PAST_SLOT}`]);
        mockRedis.hGetAll.mockResolvedValueOnce({
            shares: '100', acceptedCount: '10', rejectedCount: '0',
            rejectedJobNotFoundCount: '0', rejectedJobNotFoundDiff1: '0',
            rejectedDuplicateShareCount: '0', rejectedDuplicateShareDiff1: '0',
            rejectedLowDifficultyShareCount: '0', rejectedLowDifficultyShareDiff1: '0',
        });

        await (service as any).flushClientStatistics();

        expect(mockWorkerShares.addRejectedBulk).not.toHaveBeenCalled();
    });

    it('does not call addRejectedBulk when the DB flush fails', async () => {
        const service = buildService(mockRedis, mockWorkerShares);
        jest.spyOn(service as any, 'bulkUpsertClientStatistics').mockRejectedValue(new Error('DB error'));

        setupScan([`client:shares:addr1:rig1:sess1:${PAST_SLOT}`]);
        mockRedis.hGetAll.mockResolvedValueOnce({
            shares: '100', acceptedCount: '10', rejectedCount: '2',
            rejectedJobNotFoundCount: '2', rejectedJobNotFoundDiff1: '5',
            rejectedDuplicateShareCount: '0', rejectedDuplicateShareDiff1: '0',
            rejectedLowDifficultyShareCount: '0', rejectedLowDifficultyShareDiff1: '0',
        });

        await (service as any).flushClientStatistics();

        expect(mockWorkerShares.addRejectedBulk).not.toHaveBeenCalled();
    });

    it('does not call addRejectedBulk when there are no keys', async () => {
        const service = buildService(mockRedis, mockWorkerShares);

        setupScan([]);

        await (service as any).flushClientStatistics();

        expect(mockWorkerShares.addRejectedBulk).not.toHaveBeenCalled();
    });
});
