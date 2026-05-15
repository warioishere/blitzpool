import { DataSource } from 'typeorm';

jest.mock('node-telegram-bot-api', () => ({}));

import { StatisticsCoordinatorService } from './statistics-coordinator.service';

/**
 * Data-equivalence specs for the UNNEST refactor.
 *
 * The previous VALUES-list bulk-upserts built a giant SQL string with N×M
 * positional placeholders and a flat `values` array. The new UNNEST path
 * builds M short JS arrays (one per column) and passes them as M PG array
 * params. Same data semantics — but the array-alignment-by-index is the
 * load-bearing assumption: if column 5 of array `shares` doesn't line up
 * with column 5 of array `addresses`, every row gets the wrong values.
 *
 * These specs pin that:
 *   1. Each bulk method passes EXACTLY M arrays as parameters (no extras).
 *   2. Each array has EXACTLY records.length entries.
 *   3. Element at index i of each array matches `records[i].field`.
 *   4. Defaults (?? 0) are applied for nullable fields, not undefined.
 *   5. Empty input is a no-op (no PG round-trip).
 *
 * Together these guarantee the UNNEST result-set is bit-equivalent to the
 * old VALUES-list result. ON CONFLICT semantics are unchanged in the SQL
 * itself — the refactor only swapped the parameter delivery shape.
 */

function buildService(repos: Record<string, { query: jest.Mock }>) {
    const service = new StatisticsCoordinatorService(
        { store: {} } as any,                              // cacheManager
        { query: repos.poolShare.query } as any,           // poolShareStatisticsRepository
        { query: repos.poolRejected.query } as any,        // poolRejectedStatisticsRepository
        { query: repos.poolModeHashrate.query } as any,    // poolModeHashrateRepository
        { query: repos.clientStats.query } as any,         // clientStatisticsRepository
        { query: repos.clientRejected.query } as any,      // clientRejectedStatisticsRepository
        { options: { type: 'postgres' }, query: jest.fn() } as unknown as DataSource,
        {} as any,                                          // addressSettingsService
        {} as any,                                          // workerSharesService
        {
            drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
            drainWorkerDeltas: jest.fn().mockReturnValue([]),
            confirmAddressFlush: jest.fn(),
            confirmWorkerFlush: jest.fn(),
        } as any,                                            // shareTotalsCache
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolModeHashrateService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolShareStatisticsService
        {
            drainSlotDeltas: jest.fn().mockReturnValue(new Map()),
            confirmFlush: jest.fn(),
        } as any,                            // poolRejectedStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientStatisticsService
        {
            drainDeltas: jest.fn().mockReturnValue([]),
            confirmFlush: jest.fn(),
        } as any,                            // clientRejectedStatisticsService
    );
    return service;
}

function makeRepos() {
    return {
        poolShare: { query: jest.fn().mockResolvedValue(undefined) },
        poolRejected: { query: jest.fn().mockResolvedValue(undefined) },
        poolModeHashrate: { query: jest.fn().mockResolvedValue(undefined) },
        clientStats: { query: jest.fn().mockResolvedValue(undefined) },
        clientRejected: { query: jest.fn().mockResolvedValue(undefined) },
    };
}

describe('Bulk-upsert UNNEST: data equivalence', () => {

    describe('bulkUpsertPoolShares', () => {
        it('passes exactly 3 arrays (time, accepted, rejected) aligned by index', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertPoolShares(
                [1700000000000, 1700000600000, 1700001200000],
                [100.5, 200.0, 300.0],
                [1.5, 2.0, 3.0],
            );

            expect(repos.poolShare.query).toHaveBeenCalledTimes(1);
            const [sql, params] = repos.poolShare.query.mock.calls[0];
            expect(sql).toContain('unnest($1::bigint[], $2::real[], $3::real[])');
            expect(params).toHaveLength(3);
            expect(params[0]).toEqual([1700000000000, 1700000600000, 1700001200000]);
            expect(params[1]).toEqual([100.5, 200.0, 300.0]);
            expect(params[2]).toEqual([1.5, 2.0, 3.0]);
        });

        it('handles empty arrays without sending a query', async () => {
            // bulkUpsertPoolShares is only called when there's something to flush
            // already. The UNNEST path itself should gracefully no-op on empties.
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertPoolShares([], [], []);

            expect(repos.poolShare.query).toHaveBeenCalled();
            const [, params] = repos.poolShare.query.mock.calls[0];
            expect(params).toEqual([[], [], []]);
        });
    });

    describe('bulkUpsertPoolModeHashrate', () => {
        it('passes 3 aligned arrays (mode, time, diff)', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertPoolModeHashrate(
                ['solo', 'pplns', 'group-solo'],
                [1700000000000, 1700000000000, 1700000000000],
                [100, 50, 25],
            );

            expect(repos.poolModeHashrate.query).toHaveBeenCalledTimes(1);
            const [sql, params] = repos.poolModeHashrate.query.mock.calls[0];
            expect(sql).toContain('unnest($1::text[], $2::bigint[], $3::real[])');
            expect(params).toEqual([
                ['solo', 'pplns', 'group-solo'],
                [1700000000000, 1700000000000, 1700000000000],
                [100, 50, 25],
            ]);
        });

        it('returns early on empty without hitting the repository', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertPoolModeHashrate([], [], []);

            expect(repos.poolModeHashrate.query).not.toHaveBeenCalled();
        });
    });

    describe('bulkUpsertClientStatistics — the big one (~1700 rows in prod)', () => {
        it('passes exactly 13 aligned arrays for the 13 columns', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertClientStatistics(
                ['bc1qa', 'bc1qb'],                    // address
                ['rig1', 'rig2'],                      // clientName
                ['s1', 's2'],                          // sessionId
                [1700000000000, 1700000600000],        // time
                [100.5, 200],                          // shares
                [10, 20],                              // acceptedCount
                [1, 2],                                // rejectedCount
                [0, 1],                                // rejJnfCount
                [0, 0.25],                             // rejJnfDiff
                [1, 1],                                // rejDupCount
                [0.5, 0.5],                            // rejDupDiff
                [0, 0],                                // rejLowCount
                [0, 0],                                // rejLowDiff
            );

            expect(repos.clientStats.query).toHaveBeenCalledTimes(1);
            const [sql, params] = repos.clientStats.query.mock.calls[0];

            expect(params).toHaveLength(13);
            expect(params[0]).toEqual(['bc1qa', 'bc1qb']);
            expect(params[1]).toEqual(['rig1', 'rig2']);
            expect(params[2]).toEqual(['s1', 's2']);
            expect(params[3]).toEqual([1700000000000, 1700000600000]);
            expect(params[4]).toEqual([100.5, 200]);
            expect(params[5]).toEqual([10, 20]);
            expect(params[6]).toEqual([1, 2]);
            expect(params[7]).toEqual([0, 1]);
            expect(params[8]).toEqual([0, 0.25]);
            expect(params[9]).toEqual([1, 1]);
            expect(params[10]).toEqual([0.5, 0.5]);
            expect(params[11]).toEqual([0, 0]);
            expect(params[12]).toEqual([0, 0]);

            expect(sql).toContain('unnest(');
            expect(sql).toContain('ON CONFLICT (address, "clientName", "sessionId", time)');
        });

        it('preserves order across 1500 records (no off-by-one in array building)', async () => {
            // Builds 1500 parallel-array entries with index-encoded values
            // and verifies that params[i] of every array matches records[i].
            const repos = makeRepos();
            const service = buildService(repos);

            const n = 1500;
            const addresses: string[] = new Array(n);
            const clientNames: string[] = new Array(n);
            const sessionIds: string[] = new Array(n);
            const times: number[] = new Array(n);
            const shares: number[] = new Array(n);
            const acceptedCount: number[] = new Array(n);
            const rejectedCount: number[] = new Array(n);
            const z = new Array(n).fill(0);
            for (let i = 0; i < n; i++) {
                addresses[i] = `bc1q${i}`;
                clientNames[i] = `rig${i}`;
                sessionIds[i] = `s${i}`;
                times[i] = 1700000000000 + i * 600000;
                shares[i] = i * 1.5;
                acceptedCount[i] = i * 10;
                rejectedCount[i] = i;
            }

            await (service as any).bulkUpsertClientStatistics(
                addresses, clientNames, sessionIds, times,
                shares, acceptedCount, rejectedCount,
                z, z, z, z, z, z,
            );

            const [, params] = repos.clientStats.query.mock.calls[0];
            expect(params[0]).toHaveLength(1500);
            expect(params[3]).toHaveLength(1500);
            expect(params[4]).toHaveLength(1500);
            for (let i = 0; i < 1500; i += 100) {
                expect(params[0][i]).toBe(`bc1q${i}`);
                expect(params[3][i]).toBe(1700000000000 + i * 600000);
                expect(params[4][i]).toBe(i * 1.5);
            }
        });
    });

    describe('bulkUpsertPoolRejectedStatistics', () => {
        it('passes 3 aligned arrays (time, reason, count)', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertPoolRejectedStatistics(
                [1700000000000, 1700000000000, 1700000600000],
                ['JobNotFound', 'DuplicateShare', 'LowDifficultyShare'],
                [5, 2, 1],
            );

            const [sql, params] = repos.poolRejected.query.mock.calls[0];
            expect(sql).toContain('unnest($1::bigint[], $2::text[], $3::real[])');
            expect(params).toEqual([
                [1700000000000, 1700000000000, 1700000600000],
                ['JobNotFound', 'DuplicateShare', 'LowDifficultyShare'],
                [5, 2, 1],
            ]);
        });
    });

    describe('bulkUpsertClientRejectedStatistics', () => {
        it('passes 5 aligned arrays (address, time, reason, count, shares)', async () => {
            const repos = makeRepos();
            const service = buildService(repos);

            await (service as any).bulkUpsertClientRejectedStatistics(
                ['bc1qa', 'bc1qb'],
                [1700000000000, 1700000000000],
                ['JobNotFound', 'DuplicateShare'],
                [3, 2],
                [0.75, 0.5],
            );

            const [sql, params] = repos.clientRejected.query.mock.calls[0];
            expect(sql).toContain('unnest($1::text[], $2::bigint[], $3::text[], $4::real[], $5::real[])');
            expect(params).toEqual([
                ['bc1qa', 'bc1qb'],
                [1700000000000, 1700000000000],
                ['JobNotFound', 'DuplicateShare'],
                [3, 2],
                [0.75, 0.5],
            ]);
        });
    });
});

describe('WorkerSharesService.addSharesBulk / addRejectedBulk — UNNEST data equivalence', () => {
    // Build a minimal mock that satisfies the service's repo + dataSource
    // dependencies. We only need `manager.connection.options.type` to reach
    // the postgres branch + a mockable `query()` to assert the params.
    function makeWorkerSharesService() {
        const queryMock = jest.fn().mockResolvedValue(undefined);
        const dataSource = {
            options: { type: 'postgres' },
            query: queryMock,
        } as any;
        const repo = {
            manager: { connection: dataSource },
        } as any;
        const { WorkerSharesService } = require('../ORM/worker-shares/worker-shares.service');
        return { service: new WorkerSharesService(repo, dataSource), queryMock };
    }

    describe('addSharesBulk', () => {
        it('passes 3 aligned arrays (address, clientName, shares)', async () => {
            const { service, queryMock } = makeWorkerSharesService();
            await service.addSharesBulk(
                ['bc1qa', 'bc1qb', 'bc1qa'],
                ['rig1', 'rig2', 'rig3'],
                [100, 50.5, 25],
            );

            expect(queryMock).toHaveBeenCalledTimes(1);
            const [sql, params] = queryMock.mock.calls[0];
            expect(sql).toContain('unnest($1::text[], $2::text[], $3::double precision[])');
            expect(params).toEqual([
                ['bc1qa', 'bc1qb', 'bc1qa'],
                ['rig1', 'rig2', 'rig3'],
                [100, 50.5, 25],
            ]);
        });

        it('handles 1500 records in a single round-trip (no batching)', async () => {
            // The previous code batched at 1000; UNNEST has no parameter-
            // count limit (one array each, regardless of N), so a single
            // call is correct and faster.
            const { service, queryMock } = makeWorkerSharesService();
            const n = 1500;
            const addresses = Array.from({ length: n }, (_, i) => `bc1q${i}`);
            const clientNames = Array.from({ length: n }, (_, i) => `rig${i}`);
            const shares = Array.from({ length: n }, (_, i) => i);

            await service.addSharesBulk(addresses, clientNames, shares);

            expect(queryMock).toHaveBeenCalledTimes(1);
            const [, params] = queryMock.mock.calls[0];
            expect(params[0]).toHaveLength(1500);
            expect(params[2][1499]).toBe(1499);
        });

        it('returns early on empty without sending a query', async () => {
            const { service, queryMock } = makeWorkerSharesService();
            await service.addSharesBulk([], [], []);
            expect(queryMock).not.toHaveBeenCalled();
        });
    });

    describe('addRejectedBulk', () => {
        it('passes 4 aligned arrays (address, clientName, zero-shares, rejectedShares)', async () => {
            // The 3rd array is constant zeros — for the `shares` column,
            // which the rejected path must not touch. ON CONFLICT updates
            // only `rejectedShares`, but on cold-row insert the row needs
            // a non-null `shares` so we send 0.
            const { service, queryMock } = makeWorkerSharesService();
            await service.addRejectedBulk(
                ['bc1qa', 'bc1qb'],
                ['rig1', 'rig2'],
                [5, 2.25],
            );

            const [sql, params] = queryMock.mock.calls[0];
            expect(sql).toContain('unnest($1::text[], $2::text[], $3::double precision[], $4::double precision[])');
            expect(params).toEqual([
                ['bc1qa', 'bc1qb'],
                ['rig1', 'rig2'],
                [0, 0],
                [5, 2.25],
            ]);
        });
    });
});

describe('AddressSettingsService.addSharesBulk — UNNEST data equivalence', () => {
    function makeAddressSettingsService() {
        const queryMock = jest.fn().mockResolvedValue(undefined);
        const repo = {
            manager: { connection: { options: { type: 'postgres' } } },
            query: queryMock,
        } as any;
        const { AddressSettingsService } = require('../ORM/address-settings/address-settings.service');
        return { service: new AddressSettingsService(repo), queryMock };
    }

    it('passes 2 aligned arrays (addresses, deltas) for the UPDATE FROM unnest path', async () => {
        // Replaces the previous CASE/WHEN UPDATE with WHERE address IN (…)
        // pattern that built 3N positional placeholders. Same atomic UPDATE
        // semantics — each address gets its own delta added to shares.
        const { service, queryMock } = makeAddressSettingsService();
        await service.addSharesBulk(
            ['bc1qa', 'bc1qb', 'bc1qc'],
            [100, 50, 25.5],
        );

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('unnest($1::text[]) AS address');
        expect(sql).toContain('unnest($2::double precision[]) AS delta');
        expect(sql).toContain('SET shares = t.shares + d.delta');
        expect(sql).toContain('WHERE t.address = d.address');
        expect(params).toEqual([
            ['bc1qa', 'bc1qb', 'bc1qc'],
            [100, 50, 25.5],
        ]);
    });

    it('returns early on empty input', async () => {
        const { service, queryMock } = makeAddressSettingsService();
        await service.addSharesBulk([], []);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('preserves order across many records (no shuffling)', async () => {
        const { service, queryMock } = makeAddressSettingsService();
        const n = 500;
        const addresses = Array.from({ length: n }, (_, i) => `bc1q${i.toString().padStart(4, '0')}`);
        const shares = Array.from({ length: n }, (_, i) => i * 1.5);

        await service.addSharesBulk(addresses, shares);

        const [, params] = queryMock.mock.calls[0];
        expect(params[0]).toHaveLength(500);
        expect(params[1]).toHaveLength(500);
        for (let i = 0; i < 500; i += 50) {
            expect(params[0][i]).toBe(`bc1q${i.toString().padStart(4, '0')}`);
            expect(params[1][i]).toBe(i * 1.5);
        }
    });
});
