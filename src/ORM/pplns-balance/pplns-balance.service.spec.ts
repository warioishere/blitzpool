import { PplnsBalanceService } from './pplns-balance.service';

/**
 * markTouch() coalesces N per-share PG UPDATEs into one bulk UPDATE per
 * flush window (60 s). These specs pin:
 *   1. markTouch is synchronous and never throws.
 *   2. Multiple touches for the same address keep the latest timestamp.
 *   3. Empty buffer → no PG round-trip.
 *   4. Postgres flush uses one UPDATE … FROM unnest($1, $2).
 *   5. Sqlite (dev/test) falls back to per-row UPDATEs.
 *   6. Flush failure re-buffers so the next flush retries.
 */

function buildPostgresService(query: jest.Mock) {
    const repo: any = {
        query,
        manager: { connection: { options: { type: 'postgres' } } },
    };
    return new PplnsBalanceService(repo as any);
}

function buildSqliteService(update: jest.Mock) {
    const repo: any = {
        update,
        manager: { connection: { options: { type: 'sqlite' } } },
    };
    return new PplnsBalanceService(repo as any);
}

describe('PplnsBalanceService.markTouch / flushPendingTouches', () => {
    it('markTouch is synchronous and never throws on empty address', () => {
        const service = buildPostgresService(jest.fn());
        expect(() => service.markTouch('')).not.toThrow();
    });

    it('empty buffer is a no-op (no PG round-trip)', async () => {
        const query = jest.fn();
        const service = buildPostgresService(query);
        await service.flushPendingTouches();
        expect(query).not.toHaveBeenCalled();
    });

    it('Postgres: flushes all buffered touches in a single bulk UPDATE', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const service = buildPostgresService(query);
        const t1 = Date.UTC(2026, 4, 13, 12, 0, 0);     // 2026-05-13T12:00:00Z
        const t2 = Date.UTC(2026, 4, 13, 12, 0, 30);    // 2026-05-13T12:00:30Z
        service.markTouch('addr-A', t1);
        service.markTouch('addr-B', t2);
        service.markTouch('addr-C', t2);

        await service.flushPendingTouches();

        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toMatch(/UPDATE pplns_balance AS t/);
        expect(sql).toMatch(/unnest\(\$1::text\[\]\)/);
        expect(sql).toMatch(/unnest\(\$2::bigint\[\]\)/);
        expect(params).toHaveLength(2);
        expect(params[0]).toEqual(['addr-A', 'addr-B', 'addr-C']);
        expect(params[1]).toEqual([t1, t2, t2]);
    });

    it('keeps the latest timestamp per address when markTouch is called multiple times', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const service = buildPostgresService(query);
        const t1 = Date.UTC(2026, 4, 13, 12, 0, 0);
        const t2 = Date.UTC(2026, 4, 13, 12, 0, 30);
        service.markTouch('addr-A', t1);
        service.markTouch('addr-A', t2);

        await service.flushPendingTouches();
        const [, params] = query.mock.calls[0];
        expect(params[0]).toEqual(['addr-A']);
        expect(params[1]).toEqual([t2]);
    });

    it('re-buffers on failure so the next flush retries', async () => {
        const query = jest.fn().mockRejectedValueOnce(new Error('PG down'));
        const service = buildPostgresService(query);
        service.markTouch('addr-A');
        await service.flushPendingTouches(); // fails, re-buffers

        query.mockResolvedValueOnce(undefined);
        await service.flushPendingTouches();
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('Sqlite: falls back to per-row UPDATE for each touch', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const service = buildSqliteService(update);
        const t1 = Date.UTC(2026, 4, 13, 12, 0, 0);
        service.markTouch('addr-A', t1);
        service.markTouch('addr-B', t1);

        await service.flushPendingTouches();
        expect(update).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledWith({ address: 'addr-A' }, { lastAcceptedShareAt: t1 });
        expect(update).toHaveBeenCalledWith({ address: 'addr-B' }, { lastAcceptedShareAt: t1 });
    });

    it('newer in-memory touch is not clobbered by re-buffer after failure', async () => {
        const query = jest.fn().mockRejectedValueOnce(new Error('PG down'));
        const service = buildPostgresService(query);
        const t1 = Date.UTC(2026, 4, 13, 12, 0, 0);
        service.markTouch('addr-A', t1);
        const flushPromise = service.flushPendingTouches();
        // While the failing flush is in flight, a newer touch arrives.
        const t2 = Date.UTC(2026, 4, 13, 12, 0, 30);
        service.markTouch('addr-A', t2);
        await flushPromise;

        query.mockResolvedValueOnce(undefined);
        await service.flushPendingTouches();
        const [, params] = query.mock.calls[1];
        expect(params[1]).toEqual([t2]);
    });

    it('flushes on module destroy', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const service = buildPostgresService(query);
        service.markTouch('addr-A');
        await service.onModuleDestroy();
        expect(query).toHaveBeenCalledTimes(1);
    });
});

// ── Real-Postgres integration ─────────────────────────────────────────
//
// Validates flushPendingTouches against the local Postgres container on
// localhost:15432 — the `unnest($2::bigint[])` array of epoch-ms numbers
// is silently accepted by sqlite but PG enforces type strictly.
// See memory/feedback-pg-e2e-tests.md for container setup.
import { DataSource } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';

describe('PplnsBalanceService — real Postgres', () => {
    let dataSource: DataSource;
    let service: PplnsBalanceService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.PG_HOST ?? 'localhost',
            port: parseInt(process.env.PG_PORT ?? '15432', 10),
            username: process.env.PG_USER ?? 'postgres',
            password: process.env.PG_PASSWORD ?? 'postgres',
            database: process.env.PG_DATABASE ?? 'blitzpool_test',
            entities: [PplnsBalanceEntity],
            synchronize: true,
            dropSchema: true,
        });
        await dataSource.initialize();
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(PplnsBalanceEntity).clear();
        service = new PplnsBalanceService(
            dataSource.getRepository(PplnsBalanceEntity) as any,
        );
    });

    it('flushPendingTouches bulk-updates lastAcceptedShareAt as bigint', async () => {
        const repo = dataSource.getRepository(PplnsBalanceEntity);
        const initialTouch = Date.parse('2026-05-01T00:00:00Z');
        await repo.save([
            { address: 'addr-A', balanceSats: 1000, totalPaidSats: 0,
              lastAcceptedShareAt: initialTouch, updatedAt: initialTouch },
            { address: 'addr-B', balanceSats: 2000, totalPaidSats: 0,
              lastAcceptedShareAt: initialTouch, updatedAt: initialTouch },
        ]);

        const t1 = Date.parse('2026-05-13T12:00:00Z');
        service.markTouch('addr-A', t1);
        service.markTouch('addr-B', t1);
        await service.flushPendingTouches();

        const rowA = await repo.findOneByOrFail({ address: 'addr-A' });
        expect(rowA.lastAcceptedShareAt).toBe(t1);
        expect(typeof rowA.lastAcceptedShareAt).toBe('number');

        const rowB = await repo.findOneByOrFail({ address: 'addr-B' });
        expect(rowB.lastAcceptedShareAt).toBe(t1);
    });

    it('getBalanceSats raw-PG query returns Number for bigint column', async () => {
        const repo = dataSource.getRepository(PplnsBalanceEntity);
        await repo.save({
            address: 'addr-bal', balanceSats: 12345,
            totalPaidSats: 67890, lastAcceptedShareAt: null,
            updatedAt: Date.now(),
        });

        const sats = await service.getBalanceSats('addr-bal');
        expect(sats).toBe(12345);
        expect(typeof sats).toBe('number');
    });

    it('getBalanceLight returns number-typed sats fields', async () => {
        const repo = dataSource.getRepository(PplnsBalanceEntity);
        await repo.save({
            address: 'addr-light', balanceSats: 111, totalPaidSats: 222,
            lastAcceptedShareAt: null, updatedAt: Date.now(),
        });

        const balance = await service.getBalanceLight('addr-light');
        expect(balance).not.toBeNull();
        expect(typeof balance!.balanceSats).toBe('number');
        expect(typeof balance!.totalPaidSats).toBe('number');
        expect(balance!.balanceSats).toBe(111);
        expect(balance!.totalPaidSats).toBe(222);
    });
});
