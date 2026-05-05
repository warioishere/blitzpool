import { DataSource } from 'typeorm';

jest.mock('node-telegram-bot-api', () => ({}));

import { StatisticsCoordinatorService } from './statistics-coordinator.service';
import { WorkerSharesService } from '../ORM/worker-shares/worker-shares.service';

/**
 * Validates the pipelining refactor that collapsed thousands of sequential
 * `await hGetAll(key)` calls per flush into a handful of batched `multi()`
 * round-trips. Two surfaces:
 *
 *   1. The `pipelinedHGetAll(keys)` helper itself — order preservation,
 *      batching at 500 keys, null/error result handling, empty input.
 *
 *   2. End-to-end behaviour through `flushWorkerTotals` — the biggest
 *      O(N) caller (~1500 keys in production). Verifies the read pass
 *      goes through the pipeline (no per-key sequential awaits), filters
 *      :hydrated / :lock markers, and feeds the right deltas into
 *      WorkerSharesService.addSharesBulk.
 */

/**
 * Mock factory for the redis client. The `multi()` chain records hGetAll
 * (and hIncrByFloat / hSet for the baseline+delta passes) and replays
 * pre-queued response arrays on .exec(). Mirrors node-redis v4 enough for
 * the helper and flushers to exercise the real code paths.
 */
function makeMockRedis() {
    type Resp = Array<Record<string, string> | null | undefined | unknown>;
    const queuedExecResponses: Resp[] = [];
    const execCallLog: Array<{ commands: Array<{ op: string; args: any[] }> }> = [];

    const multi = jest.fn(function () {
        const commands: Array<{ op: string; args: any[] }> = [];
        const chain: any = {
            hGetAll: (key: string) => { commands.push({ op: 'hGetAll', args: [key] }); return chain; },
            hIncrByFloat: (k: string, f: string, v: number) => { commands.push({ op: 'hIncrByFloat', args: [k, f, v] }); return chain; },
            hSet: (k: string, f: string, v: string) => { commands.push({ op: 'hSet', args: [k, f, v] }); return chain; },
            exec: async () => {
                execCallLog.push({ commands });
                const next = queuedExecResponses.shift();
                if (next === undefined) {
                    // No queued response → return empty array per command (default)
                    return commands.map(() => ({}));
                }
                return next;
            },
        };
        return chain;
    });

    return {
        client: {
            scan: jest.fn(),
            hGetAll: jest.fn(),
            del: jest.fn().mockResolvedValue(undefined),
            multi,
        },
        queueExec: (resp: Resp) => { queuedExecResponses.push(resp); },
        execCallLog,
    };
}

function buildService(mockRedis: any, mockWorkerShares: Partial<WorkerSharesService> = {}) {
    const service = new StatisticsCoordinatorService(
        { store: {} } as any,           // cacheManager — onModuleInit skipped via direct injection below
        {} as any,                       // poolShareStatisticsRepository
        {} as any,                       // poolRejectedStatisticsRepository
        {} as any,                       // poolModeHashrateRepository
        {} as any,                       // clientStatisticsRepository
        {} as any,                       // clientRejectedStatisticsRepository
        { options: { type: 'postgres' }, query: jest.fn() } as unknown as DataSource,
        {} as any,                       // addressSettingsService
        mockWorkerShares as WorkerSharesService,
    );
    (service as any).redisClient = mockRedis;
    return service;
}

describe('StatisticsCoordinatorService – pipelinedHGetAll helper', () => {
    let mockRedis: any;
    let queueExec: (resp: any[]) => void;
    let service: any;

    beforeEach(() => {
        const m = makeMockRedis();
        mockRedis = m.client;
        queueExec = m.queueExec;
        service = buildService(mockRedis);
    });

    it('returns empty array for empty input without calling multi()', async () => {
        const result = await (service as any).pipelinedHGetAll([]);
        expect(result).toEqual([]);
        expect(mockRedis.multi).not.toHaveBeenCalled();
    });

    it('returns hashes in the same order as the input keys', async () => {
        const keys = ['a', 'b', 'c'];
        queueExec([
            { v: '1' },  // for 'a'
            { v: '2' },  // for 'b'
            { v: '3' },  // for 'c'
        ]);

        const result = await (service as any).pipelinedHGetAll(keys);

        expect(result).toEqual([
            { v: '1' },
            { v: '2' },
            { v: '3' },
        ]);
    });

    it('uses a single multi() call for ≤500 keys (single batch)', async () => {
        const keys = Array.from({ length: 500 }, (_, i) => `k${i}`);
        queueExec(keys.map(k => ({ key: k })));

        await (service as any).pipelinedHGetAll(keys);

        expect(mockRedis.multi).toHaveBeenCalledTimes(1);
    });

    it('batches into 500-key chunks: 1100 keys → 3 multi() pipelines', async () => {
        const keys = Array.from({ length: 1100 }, (_, i) => `k${i}`);
        // 3 batches: 500 + 500 + 100
        queueExec(keys.slice(0, 500).map(k => ({ key: k })));
        queueExec(keys.slice(500, 1000).map(k => ({ key: k })));
        queueExec(keys.slice(1000, 1100).map(k => ({ key: k })));

        const result = await (service as any).pipelinedHGetAll(keys);

        expect(mockRedis.multi).toHaveBeenCalledTimes(3);
        expect(result).toHaveLength(1100);
        expect(result[0]).toEqual({ key: 'k0' });
        expect(result[499]).toEqual({ key: 'k499' });
        expect(result[500]).toEqual({ key: 'k500' });
        expect(result[1099]).toEqual({ key: 'k1099' });
    });

    it('maps null/undefined exec entries to null in the output', async () => {
        // Real-world: a key was DEL'd between SCAN and pipeline exec —
        // node-redis returns null for that hGetAll. Caller should still
        // get the indexed result but as null so it can be skipped.
        queueExec([{ a: '1' }, null, undefined, { b: '2' }]);

        const result = await (service as any).pipelinedHGetAll(['k1', 'k2', 'k3', 'k4']);

        expect(result).toEqual([{ a: '1' }, null, null, { b: '2' }]);
    });

    it('maps array-shaped (error reply) results to null', async () => {
        // node-redis v4 returns the raw reply per pipelined command;
        // a low-level error / wrong-type reply shows up as an array.
        // The helper must sanitize so the caller's null-check works.
        queueExec([{ ok: '1' }, ['ERR wrong type'] as any]);

        const result = await (service as any).pipelinedHGetAll(['k1', 'k2']);

        expect(result).toEqual([{ ok: '1' }, null]);
    });

    it('per-batch ordering is preserved across multiple batches', async () => {
        const keys = Array.from({ length: 750 }, (_, i) => `key-${i}`);
        // Batch 1: 500 keys, payload encodes index
        queueExec(Array.from({ length: 500 }, (_, i) => ({ idx: String(i) })));
        // Batch 2: 250 keys, payload encodes index 500..749
        queueExec(Array.from({ length: 250 }, (_, i) => ({ idx: String(500 + i) })));

        const result = await (service as any).pipelinedHGetAll(keys);

        expect(result).toHaveLength(750);
        for (let i = 0; i < 750; i++) {
            expect((result[i] as any).idx).toBe(String(i));
        }
    });
});


describe('StatisticsCoordinatorService – flushWorkerTotals end-to-end (pipelined)', () => {
    let mockRedis: any;
    let queueExec: (resp: any[]) => void;
    let mockWorkerShares: { addSharesBulk: jest.Mock };
    let service: any;

    beforeEach(() => {
        const m = makeMockRedis();
        mockRedis = m.client;
        queueExec = m.queueExec;
        mockWorkerShares = { addSharesBulk: jest.fn().mockResolvedValue(undefined) };
        service = buildService(mockRedis, mockWorkerShares);
    });

    function setupScan(keys: string[]) {
        // scanKeys cursors '0' → keys → '0' to terminate.
        mockRedis.scan.mockResolvedValueOnce({ cursor: 0, keys });
    }

    it('filters :hydrated / :lock markers before pipelining the read', async () => {
        setupScan([
            'shares:worker:bc1qa:rig1:hydrated',
            'shares:worker:bc1qa:rig1',
            'shares:worker:bc1qb:rig2:lock',
            'shares:worker:bc1qb:rig2',
        ]);

        // Read pass: 2 data keys → expect ONE multi() call with 2 hGetAll
        queueExec([
            { delta: '50', baseline: '100' },
            { delta: '30', baseline: '200' },
        ]);
        // Baseline-read pass after DB success: same 2 keys
        queueExec([
            { delta: '50', baseline: '100' },
            { delta: '30', baseline: '200' },
        ]);
        // Decrement-deltas pass: returns ignored
        queueExec([{}, {}]);
        // Update-baselines pass: returns ignored
        queueExec([{}, {}]);

        await (service as any).flushWorkerTotals();

        // The read pass must NOT have been a sequential per-key hGetAll.
        // (mockRedis.hGetAll is only used in the spec's mock if NOT called
        // through multi(). The flushers always use the helper now.)
        expect(mockRedis.hGetAll).not.toHaveBeenCalled();
        // multi() called: 1 read + 3 baseline/delta passes = 4
        expect(mockRedis.multi).toHaveBeenCalledTimes(4);

        // addSharesBulk got the correct deltas, :hydrated/:lock keys were
        // filtered out.
        expect(mockWorkerShares.addSharesBulk).toHaveBeenCalledTimes(1);
        const args = mockWorkerShares.addSharesBulk.mock.calls[0][0];
        expect(args).toEqual([
            { address: 'bc1qa', clientName: 'rig1', shares: 50 },
            { address: 'bc1qb', clientName: 'rig2', shares: 30 },
        ]);
    });

    it('skips keys with delta=0 and keys missing the delta field', async () => {
        setupScan([
            'shares:worker:bc1qa:rig1',
            'shares:worker:bc1qb:rig2',
            'shares:worker:bc1qc:rig3',
        ]);

        queueExec([
            { delta: '50', baseline: '100' },     // include
            { baseline: '200' },                   // no delta → skip
            { delta: '0', baseline: '300' },       // delta == 0 → skip
        ]);
        // No baseline-update passes expected because 0 deltas would skip
        // the entire DB write — but with 1 valid update, those passes run.
        queueExec([{ delta: '50', baseline: '100' }]);
        queueExec([{}]);
        queueExec([{}]);

        await (service as any).flushWorkerTotals();

        expect(mockWorkerShares.addSharesBulk).toHaveBeenCalledWith([
            { address: 'bc1qa', clientName: 'rig1', shares: 50 },
        ]);
    });

    it('returns early without DB write if all data keys have zero/missing delta', async () => {
        setupScan([
            'shares:worker:bc1qa:rig1',
            'shares:worker:bc1qb:rig2',
        ]);

        queueExec([
            { baseline: '100' },                   // no delta
            { delta: '0', baseline: '200' },       // zero delta
        ]);

        await (service as any).flushWorkerTotals();

        expect(mockWorkerShares.addSharesBulk).not.toHaveBeenCalled();
        // Only the read pass should have run; no baseline-update passes.
        expect(mockRedis.multi).toHaveBeenCalledTimes(1);
    });

    it('preserves clientName containing colons (slice(3).join)', async () => {
        // Worker names can contain colons — the parser slices off the
        // first three :-separated parts (shares:worker:{address}) and
        // re-joins the rest. Pipelining mustn't break this.
        setupScan(['shares:worker:bc1qa:rig:with:colons']);

        queueExec([{ delta: '10', baseline: '0' }]);
        queueExec([{ delta: '10', baseline: '0' }]);
        queueExec([{}]);
        queueExec([{}]);

        await (service as any).flushWorkerTotals();

        expect(mockWorkerShares.addSharesBulk).toHaveBeenCalledWith([
            { address: 'bc1qa', clientName: 'rig:with:colons', shares: 10 },
        ]);
    });

    it('does NOT decrement deltas if DB write fails (data preserved for retry)', async () => {
        setupScan(['shares:worker:bc1qa:rig1']);
        queueExec([{ delta: '50', baseline: '100' }]);

        mockWorkerShares.addSharesBulk.mockRejectedValueOnce(new Error('DB down'));

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
        try {
            await (service as any).flushWorkerTotals();
        } finally {
            consoleSpy.mockRestore();
        }

        // Read pass ran, but no baseline/decrement passes — they're behind
        // the DB-success guard.
        expect(mockRedis.multi).toHaveBeenCalledTimes(1);
    });
});
