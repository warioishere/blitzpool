jest.mock('node-telegram-bot-api', () => ({}));

import { DataSource } from 'typeorm';

import { StatisticsCoordinatorService } from './statistics-coordinator.service';
import { PoolShareStatisticsEntity } from '../ORM/pool-share-statistics/pool-share-statistics.entity';
import { PoolRejectedStatisticsEntity } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolModeHashrateEntity } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientRejectedStatisticsEntity } from '../ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { TrackedEntityTimestampSubscriber } from '../ORM/utils/tracked-entity.subscriber';

/**
 * Real-Postgres integration for the StatisticsCoordinator's
 * `bulkUpsertXxx` methods. The unit spec mocks `repository.query` and
 * asserts the SQL string + params shape; the equivalence e2e spec
 * runs hand-built SQL. Neither executes the actual production SQL
 * against a real PG schema, which is what missed the `"updatedAt" =
 * NOW()` bigint-vs-timestamptz bug on 2026-05-13.
 *
 * This spec wires the real coordinator with TypeORM-managed entities
 * (post-bigint schema) and calls the production methods directly so
 * the SQL actually runs against bigint columns.
 *
 * Container: localhost:15432 (see memory/feedback-pg-e2e-tests.md).
 */
describe('StatisticsCoordinator.bulkUpsert* — real Postgres', () => {
    let dataSource: DataSource;
    let service: StatisticsCoordinatorService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.PG_HOST ?? 'localhost',
            port: parseInt(process.env.PG_PORT ?? '15432', 10),
            username: process.env.PG_USER ?? 'postgres',
            password: process.env.PG_PASSWORD ?? 'postgres',
            database: process.env.PG_DATABASE ?? 'blitzpool_test',
            entities: [
                PoolShareStatisticsEntity,
                PoolRejectedStatisticsEntity,
                PoolModeHashrateEntity,
                ClientStatisticsEntity,
                ClientRejectedStatisticsEntity,
            ],
            subscribers: [TrackedEntityTimestampSubscriber],
            synchronize: true,
            dropSchema: true,
        });
        await dataSource.initialize();

        // synchronize creates the table without DB defaults; the bigint
        // migrations (1781000-1781400) set these so raw INSERTs through the
        // unnest path pick them up. Apply the same here.
        const tables = [
            'client_statistics_entity', 'client_rejected_statistics_entity',
            'pool_share_statistics_entity', 'pool_rejected_statistics_entity',
        ];
        for (const t of tables) {
            await dataSource.query(
                `ALTER TABLE ${t} ALTER COLUMN "createdAt" SET DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`,
            );
            await dataSource.query(
                `ALTER TABLE ${t} ALTER COLUMN "updatedAt" SET DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`,
            );
        }

        // Build a minimal service instance. Only the bulkUpsert*
        // methods are exercised; other deps stay as stubs.
        service = new StatisticsCoordinatorService(
            { store: {} } as any,
            dataSource.getRepository(PoolShareStatisticsEntity),
            dataSource.getRepository(PoolRejectedStatisticsEntity),
            dataSource.getRepository(PoolModeHashrateEntity),
            dataSource.getRepository(ClientStatisticsEntity),
            dataSource.getRepository(ClientRejectedStatisticsEntity),
            dataSource,
            {} as any, {} as any,                       // addressSettings, workerShares
            {
                drainAddressDeltas: jest.fn().mockReturnValue(new Map()),
                drainWorkerDeltas: jest.fn().mockReturnValue([]),
                confirmAddressFlush: jest.fn(),
                confirmWorkerFlush: jest.fn(),
            } as any,
            { drainSlotDeltas: jest.fn().mockReturnValue(new Map()), confirmFlush: jest.fn() } as any,
            { drainSlotDeltas: jest.fn().mockReturnValue(new Map()), confirmFlush: jest.fn() } as any,
            { drainSlotDeltas: jest.fn().mockReturnValue(new Map()), confirmFlush: jest.fn() } as any,
            { drainDeltas: jest.fn().mockReturnValue([]), confirmFlush: jest.fn() } as any,
            { drainDeltas: jest.fn().mockReturnValue([]), confirmFlush: jest.fn() } as any,
        );
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(PoolShareStatisticsEntity).clear();
        await dataSource.getRepository(PoolRejectedStatisticsEntity).clear();
        await dataSource.getRepository(PoolModeHashrateEntity).clear();
        await dataSource.getRepository(ClientStatisticsEntity).clear();
        await dataSource.getRepository(ClientRejectedStatisticsEntity).clear();
    });

    it('bulkUpsertPoolShares inserts rows + ON CONFLICT bigint updatedAt works', async () => {
        await (service as any).bulkUpsertPoolShares(
            [1700000000000, 1700000600000],
            [100, 200],
            [1, 2],
        );

        // Re-call with overlapping time → ON CONFLICT path with
        // updatedAt = (EXTRACT EPOCH FROM NOW())*1000 must NOT error.
        await (service as any).bulkUpsertPoolShares(
            [1700000000000],
            [50],
            [3],
        );

        const rows = await dataSource.getRepository(PoolShareStatisticsEntity)
            .find({ order: { time: 'ASC' } });
        expect(rows).toHaveLength(2);
        expect(rows[0].accepted).toBe(150);             // 100 + 50 accumulated
        expect(rows[0].rejected).toBe(4);               // 1 + 3
        expect(typeof rows[0].updatedAt).toBe('number');
    });

    it('bulkUpsertPoolModeHashrate inserts + accumulates via ON CONFLICT', async () => {
        await (service as any).bulkUpsertPoolModeHashrate(
            ['solo', 'pplns'],
            [1700000000000, 1700000000000],
            [100, 50],
        );
        await (service as any).bulkUpsertPoolModeHashrate(
            ['solo'],
            [1700000000000],
            [25],
        );

        const rows = await dataSource.getRepository(PoolModeHashrateEntity)
            .find({ order: { mode: 'ASC' } });
        expect(rows).toHaveLength(2);
        const solo = rows.find(r => r.mode === 'solo')!;
        expect(solo.diff).toBe(125);
    });

    it('bulkUpsertClientStatistics: 13 columns + ON CONFLICT updates bigint updatedAt', async () => {
        await (service as any).bulkUpsertClientStatistics(
            ['bc1qa'], ['rig1'], ['s1'], [1700000000000],
            [100], [10], [1],
            [0], [0], [0], [0], [0], [0],
        );

        // Hit ON CONFLICT — this is where NOW() would have failed.
        await (service as any).bulkUpsertClientStatistics(
            ['bc1qa'], ['rig1'], ['s1'], [1700000000000],
            [50], [5], [0],
            [0], [0], [0], [0], [0], [0],
        );

        const row = await dataSource.getRepository(ClientStatisticsEntity)
            .findOneByOrFail({ address: 'bc1qa', clientName: 'rig1', sessionId: 's1' });
        expect(row.shares).toBe(150);
        expect(row.acceptedCount).toBe(15);
        expect(typeof row.updatedAt).toBe('number');
    });

    it('bulkUpsertPoolRejectedStatistics: ON CONFLICT bigint updatedAt', async () => {
        await (service as any).bulkUpsertPoolRejectedStatistics(
            [1700000000000, 1700000600000],
            ['JobNotFound', 'DuplicateShare'],
            [5, 2],
        );

        await (service as any).bulkUpsertPoolRejectedStatistics(
            [1700000000000],
            ['JobNotFound'],
            [3],
        );

        const row = await dataSource.getRepository(PoolRejectedStatisticsEntity)
            .findOneByOrFail({ time: 1700000000000, reason: 'JobNotFound' });
        expect(row.count).toBe(8);
        expect(typeof row.updatedAt).toBe('number');
    });

    it('bulkUpsertClientRejectedStatistics: ON CONFLICT bigint updatedAt', async () => {
        await (service as any).bulkUpsertClientRejectedStatistics(
            ['bc1qa'],
            [1700000000000],
            ['JobNotFound'],
            [3],
            [0.75],
        );

        await (service as any).bulkUpsertClientRejectedStatistics(
            ['bc1qa'],
            [1700000000000],
            ['JobNotFound'],
            [2],
            [0.5],
        );

        const row = await dataSource.getRepository(ClientRejectedStatisticsEntity)
            .findOneByOrFail({ address: 'bc1qa', time: 1700000000000, reason: 'JobNotFound' });
        expect(row.count).toBe(5);
        expect(row.shares).toBeCloseTo(1.25, 5);
        expect(typeof row.updatedAt).toBe('number');
    });
});
