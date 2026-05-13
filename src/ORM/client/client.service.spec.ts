import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { ClientEntity } from './client.entity';
import { ClientService } from './client.service';
import { TrackedEntityTimestampSubscriber } from '../utils/tracked-entity.subscriber';

type DataSourceSetup = { dataSource: DataSource; pgMem?: ReturnType<typeof newDb> };

async function createDataSource(driver: 'sqlite' | 'postgres'): Promise<DataSourceSetup> {
  if (driver === 'sqlite') {
    const dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      dropSchema: true,
      synchronize: true,
      entities: [ClientEntity],
      subscribers: [TrackedEntityTimestampSubscriber],
    });

    await dataSource.initialize();
    return { dataSource };
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'pg_mem',
  });
  db.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'pg-mem',
  });

  const dataSource = db.adapters.createTypeormDataSource({
    type: 'postgres',
    database: 'pg-mem',
    synchronize: true,
    entities: [ClientEntity],
    subscribers: [TrackedEntityTimestampSubscriber],
  });

  await dataSource.initialize();
  return { dataSource, pgMem: db };
}

describe.each(['sqlite', 'postgres'] as const)(
  'ClientService.killDeadClients (%s)',
  (driver) => {
    let dataSource: DataSource;
    let pgMem: ReturnType<typeof newDb> | undefined;
    let service: ClientService;

    beforeAll(async () => {
      const setup = await createDataSource(driver);
      dataSource = setup.dataSource;
      pgMem = setup.pgMem;
      service = new ClientService(dataSource.getRepository(ClientEntity));
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await dataSource.getRepository(ClientEntity).clear();
    });

    it('marks stale clients as deleted without touching active clients', async () => {
      const repository = dataSource.getRepository(ClientEntity);
      const now = Date.parse('2024-01-08T00:00:00Z');
      const staleUpdatedAt = now - 10 * 60 * 1000;
      const recentUpdatedAt = now - 60 * 1000;

      const rows: Array<[string, string, string, string | null, number, number, number, number, number, number, number | null]> = [
        ['addr-old', 'worker-old', 'sess0001', null, now, now, 0, 0, now, staleUpdatedAt, null],
        ['addr-fresh', 'worker-fresh', 'sess0002', null, now, now, 0, 0, now, recentUpdatedAt, null],
        ['addr-deleted', 'worker-deleted', 'sess0003', null, now, now, 0, 0, now, staleUpdatedAt, now],
      ];

      const sqliteInsert = `
        INSERT INTO client_entity (
          "address",
          "clientName",
          "sessionId",
          "userAgent",
          "startTime",
          "firstSeen",
          "bestDifficulty",
          "hashRate",
          "createdAt",
          "updatedAt",
          "deletedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      const toSqlLiteral = (value: string | number | null) => {
        if (value === null) return 'NULL';
        if (typeof value === 'number') return value.toString();
        const escaped = value.replace(/'/g, "''");
        return `'${escaped}'`;
      };

      for (const row of rows) {
        if (pgMem) {
          const values = row.map(toSqlLiteral).join(', ');
          await pgMem.public.none(`
            INSERT INTO client_entity (
              "address",
              "clientName",
              "sessionId",
              "userAgent",
              "startTime",
              "firstSeen",
              "bestDifficulty",
              "hashRate",
              "createdAt",
              "updatedAt",
              "deletedAt"
            ) VALUES (${values});
          `);
        } else {
          await dataSource.query(sqliteInsert, row);
        }
      }

      await repository
        .createQueryBuilder()
        .update(ClientEntity)
        .set({ updatedAt: staleUpdatedAt })
        .where('sessionId = :sessionId', { sessionId: 'sess0001' })
        .execute();
      await repository
        .createQueryBuilder()
        .update(ClientEntity)
        .set({ updatedAt: recentUpdatedAt })
        .where('sessionId = :sessionId', { sessionId: 'sess0002' })
        .execute();
      await repository
        .createQueryBuilder()
        .update(ClientEntity)
        .set({ updatedAt: staleUpdatedAt, deletedAt: now })
        .where('sessionId = :sessionId', { sessionId: 'sess0003' })
        .execute();

      const result = await service.killDeadClients();
      expect(result.affected ?? 0).toBeGreaterThan(0);

      const staleClient = await repository
        .createQueryBuilder('client')
        .withDeleted()
        .select('client.deletedAt', 'deletedAt')
        .where('client.address = :address', { address: 'addr-old' })
        .andWhere('client.clientName = :clientName', { clientName: 'worker-old' })
        .andWhere('client.sessionId = :sessionId', { sessionId: 'sess0001' })
        .getRawOne<{ deletedAt: number | null }>();
      const activeClient = await repository
        .createQueryBuilder('client')
        .select('client.deletedAt', 'deletedAt')
        .where('client.address = :address', { address: 'addr-fresh' })
        .andWhere('client.clientName = :clientName', { clientName: 'worker-fresh' })
        .andWhere('client.sessionId = :sessionId', { sessionId: 'sess0002' })
        .getRawOne<{ deletedAt: number | null }>();
      const alreadyDeleted = await repository
        .createQueryBuilder('client')
        .withDeleted()
        .select('client.deletedAt', 'deletedAt')
        .where('client.address = :address', { address: 'addr-deleted' })
        .andWhere('client.clientName = :clientName', { clientName: 'worker-deleted' })
        .andWhere('client.sessionId = :sessionId', { sessionId: 'sess0003' })
        .getRawOne<{ deletedAt: number | null }>();

      expect(staleClient?.deletedAt).not.toBeNull();
      expect(activeClient?.deletedAt ?? null).toBeNull();
      expect(alreadyDeleted?.deletedAt).not.toBeNull();
    });
  },
);

// ── getByAddressLight equivalence ──────────────────────────────────
//
// `getByAddressLight` is the hot-path replacement for `getByAddress`
// used by the `GET /api/client/:address` dashboard endpoint. It skips
// TypeORM entity hydration on Postgres (raw SELECT) and falls back to
// the entity query on sqlite. This describe pins that, for the 7 fields
// the controller actually consumes, both methods produce equivalent
// output on a populated table.
describe.each(['sqlite', 'postgres'] as const)(
  'ClientService.getByAddressLight equivalence (%s)',
  (driver) => {
    let dataSource: DataSource;
    let pgMem: ReturnType<typeof newDb> | undefined;
    let service: ClientService;

    beforeAll(async () => {
      const setup = await createDataSource(driver);
      dataSource = setup.dataSource;
      pgMem = setup.pgMem;
      service = new ClientService(dataSource.getRepository(ClientEntity));
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await dataSource.getRepository(ClientEntity).clear();
    });

    it('returns the same {sessionId, clientName, bestDifficulty, hashRate, currentDifficulty, startTime, updatedAt} for each row as getByAddress', async () => {
      const repo = dataSource.getRepository(ClientEntity);
      const now = Date.parse('2024-06-01T12:00:00Z');
      const earlier = Date.parse('2024-06-01T10:00:00Z');

      await repo.save([
        {
          address: 'btc-test',
          clientName: 'worker-a',
          sessionId: 'sess0aaa',
          userAgent: 'ua-a',
          startTime: earlier,
          firstSeen: earlier,
          bestDifficulty: 123.45,
          hashRate: 1000,
          currentDifficulty: 4096,
          createdAt: earlier,
          updatedAt: now,
        },
        {
          address: 'btc-test',
          clientName: 'worker-b',
          sessionId: 'sess0bbb',
          userAgent: 'ua-b',
          startTime: earlier,
          firstSeen: earlier,
          bestDifficulty: 0.5,
          hashRate: 250,
          currentDifficulty: null,
          createdAt: earlier,
          updatedAt: now,
        },
      ]);

      const legacy = await service.getByAddress('btc-test');
      const light = await service.getByAddressLight('btc-test');

      expect(light.length).toBe(legacy.length);

      // Map both shapes by composite key so we can compare row-by-row
      // regardless of result ordering.
      const keyOf = (r: any) => `${r.sessionId}|${r.clientName}`;
      const legacyByKey = new Map(legacy.map((r) => [keyOf(r), r]));

      for (const lightRow of light) {
        const legacyRow = legacyByKey.get(keyOf(lightRow));
        expect(legacyRow).toBeDefined();
        expect(lightRow.sessionId).toBe(legacyRow!.sessionId);
        expect(lightRow.clientName).toBe(legacyRow!.clientName);
        expect(lightRow.bestDifficulty).toBe(legacyRow!.bestDifficulty);
        expect(lightRow.hashRate).toBe(legacyRow!.hashRate);
        expect(lightRow.currentDifficulty).toBe(legacyRow!.currentDifficulty);
        // bigint columns come back as string on raw PG queries, as number
        // through entity hydration — normalize both before compare.
        expect(Number(lightRow.startTime)).toBe(Number(legacyRow!.startTime));
        expect(Number(lightRow.updatedAt)).toBe(Number(legacyRow!.updatedAt));
      }
    });

    it('excludes soft-deleted rows (deletedAt IS NULL) just like getByAddress default', async () => {
      const repo = dataSource.getRepository(ClientEntity);
      const now = Date.parse('2024-06-01T12:00:00Z');

      await repo.save([
        {
          address: 'btc-test', clientName: 'live', sessionId: 'sess0liv',
          userAgent: null, startTime: now, firstSeen: now,
          bestDifficulty: 1, hashRate: 100, currentDifficulty: null,
          createdAt: now, updatedAt: now,
        },
        {
          address: 'btc-test', clientName: 'gone', sessionId: 'sess0gon',
          userAgent: null, startTime: now, firstSeen: now,
          bestDifficulty: 1, hashRate: 100, currentDifficulty: null,
          createdAt: now, updatedAt: now, deletedAt: now,
        },
      ]);

      const light = await service.getByAddressLight('btc-test');
      expect(light.length).toBe(1);
      expect((light[0] as any).clientName).toBe('live');
    });

    it('returns an empty array for an unknown address', async () => {
      const light = await service.getByAddressLight('unknown-address');
      expect(light).toEqual([]);
    });

    // Suppress unused: pgMem is declared for symmetry with the killDeadClients
    // describe block above; not needed here.
    void pgMem;
  },
);

// ── flushHeartbeats bulk Postgres path ──────────────────────────────
//
// Hot path on prod (every 30 s). Postgres branch issues one bulk UPDATE
// via parallel-array unnest; sqlite keeps per-row updates for dev/test.
// pg-mem doesn't support parallel-array unnest, so the Postgres branch
// is covered by mocking the repository's `query` method and pinning the
// SQL + array-shape directly. End-to-end behaviour on the sqlite per-row
// path is covered by the in-memory DataSource block below.
describe('ClientService.flushHeartbeats — bulk Postgres path', () => {
  function buildPostgresService(query: jest.Mock) {
    const repo: any = {
      query,
      manager: {
        connection: { options: { type: 'postgres' } },
        transaction: jest.fn(),
      },
    };
    return new ClientService(repo as any);
  }

  it('empty buffer is a no-op (no PG round-trip)', async () => {
    const query = jest.fn();
    const service = buildPostgresService(query);
    await service.flushHeartbeats();
    expect(query).not.toHaveBeenCalled();
  });

  it('issues exactly one UPDATE with 7 parallel arrays aligned by index', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = buildPostgresService(query);

    const t1 = Date.parse('2026-05-13T12:00:00.000Z');
    const t2 = Date.parse('2026-05-13T12:00:30.000Z');
    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 100, t1, 2048);
    await service.heartbeat('addr-B', 'rig-B', 'sess-B', 200, t2, null);
    // 6-arg form: currentDifficulty omitted entirely
    await service.heartbeat('addr-C', 'rig-C', 'sess-C', 300, t2);

    await service.flushHeartbeats();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE client_entity AS t/);
    expect(sql).toMatch(/FROM\s*\(\s*SELECT/);
    expect(sql).toMatch(/unnest\(\$1::text\[\]\)/);
    expect(sql).toMatch(/unnest\(\$5::bigint\[\]\)/);
    expect(sql).toMatch(/CASE WHEN u\."updateDiff" THEN u\."currentDifficulty" ELSE t\."currentDifficulty" END/);

    expect(params).toHaveLength(7);
    const [addresses, clientNames, sessionIds, hashRates, updatedAts, updateDiff, currentDifficulties] = params;
    expect(addresses).toEqual(['addr-A', 'addr-B', 'addr-C']);
    expect(clientNames).toEqual(['rig-A', 'rig-B', 'rig-C']);
    expect(sessionIds).toEqual(['sess-A', 'sess-B', 'sess-C']);
    expect(hashRates).toEqual([100, 200, 300]);
    expect(updatedAts).toEqual([t1, t2, t2]);
    // updateDiff guards the CASE: true → set, false → leave column alone.
    expect(updateDiff).toEqual([true, true, false]);
    // null is a legitimate "set to NULL"; undefined is "don't touch column".
    expect(currentDifficulties).toEqual([2048, null, null]);
  });

  it('latest heartbeat per sessionId wins', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = buildPostgresService(query);

    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 100, 1, 100);
    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 500, 2, 200);

    await service.flushHeartbeats();

    const [, params] = query.mock.calls[0];
    const [addresses, , , hashRates, , , currentDifficulties] = params;
    expect(addresses).toEqual(['addr-A']);
    expect(hashRates).toEqual([500]);
    expect(currentDifficulties).toEqual([200]);
  });

  it('re-buffers the snapshot on bulk UPDATE failure so the next flush retries', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('PG down'));
    const service = buildPostgresService(query);

    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 100, 1, 2048);
    await service.heartbeat('addr-B', 'rig-B', 'sess-B', 200, 1, 4096);
    await service.flushHeartbeats(); // first call: rejected, re-buffered

    query.mockResolvedValueOnce(undefined);
    await service.flushHeartbeats();
    expect(query).toHaveBeenCalledTimes(2);
    const [, params] = query.mock.calls[1];
    expect(params[0]).toEqual(['addr-A', 'addr-B']);
  });

  it('does not overwrite a newer in-memory heartbeat with the re-buffered older one', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('PG down'));
    const service = buildPostgresService(query);

    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 100, 1, 2048);
    const inflight = service.flushHeartbeats();
    // While the failing flush is in flight, a newer heartbeat for the same
    // sessionId arrives.
    await service.heartbeat('addr-A', 'rig-A', 'sess-A', 999, 2, 8192);
    await inflight;

    query.mockResolvedValueOnce(undefined);
    await service.flushHeartbeats();
    const [, params] = query.mock.calls[1];
    expect(params[3]).toEqual([999]);
    expect(params[6]).toEqual([8192]);
  });
});

describe('ClientService.flushHeartbeats — sqlite per-row path (in-memory)', () => {
  let dataSource: DataSource;
  let service: ClientService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      dropSchema: true,
      synchronize: true,
      entities: [ClientEntity],
      subscribers: [TrackedEntityTimestampSubscriber],
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(ClientEntity).clear();
    service = new ClientService(dataSource.getRepository(ClientEntity));
  });

  it('updates buffered sessions end-to-end on sqlite', async () => {
    const repo = dataSource.getRepository(ClientEntity);
    const t0 = Date.parse('2026-05-13T11:00:00.000Z');
    await repo.save({
      address: 'addr-X',
      clientName: 'rig-X',
      sessionId: 'sess-X',
      startTime: t0,
      firstSeen: t0,
      hashRate: 0,
      bestDifficulty: 0,
      currentDifficulty: 1024,
    });

    const t1 = Date.parse('2026-05-13T12:00:00.000Z');
    await service.heartbeat('addr-X', 'rig-X', 'sess-X', 4242, t1, 8192);
    await service.flushHeartbeats();

    const row = await repo.findOneBy({ address: 'addr-X', clientName: 'rig-X', sessionId: 'sess-X' });
    expect(row?.hashRate).toBe(4242);
    expect(row?.currentDifficulty).toBe(8192);
  });

  it('omitted currentDifficulty leaves the column value untouched', async () => {
    const repo = dataSource.getRepository(ClientEntity);
    const t0 = Date.parse('2026-05-13T11:00:00.000Z');
    await repo.save({
      address: 'addr-Y',
      clientName: 'rig-Y',
      sessionId: 'sess-Y',
      startTime: t0,
      firstSeen: t0,
      hashRate: 0,
      bestDifficulty: 0,
      currentDifficulty: 1024,
    });

    const t1 = Date.parse('2026-05-13T12:00:00.000Z');
    await service.heartbeat('addr-Y', 'rig-Y', 'sess-Y', 4242, t1);
    await service.flushHeartbeats();

    const row = await repo.findOneBy({ address: 'addr-Y', clientName: 'rig-Y', sessionId: 'sess-Y' });
    expect(row?.hashRate).toBe(4242);
    expect(row?.currentDifficulty).toBe(1024);
  });
});
