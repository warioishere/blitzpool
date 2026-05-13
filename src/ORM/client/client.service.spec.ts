import { DataSource } from 'typeorm';
import { DataType, newDb } from 'pg-mem';

import { ClientEntity } from './client.entity';
import { ClientService } from './client.service';

type DataSourceSetup = { dataSource: DataSource; pgMem?: ReturnType<typeof newDb> };

async function createDataSource(driver: 'sqlite' | 'postgres'): Promise<DataSourceSetup> {
  if (driver === 'sqlite') {
    const dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      dropSchema: true,
      synchronize: true,
      entities: [ClientEntity],
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
      const now = new Date('2024-01-08T00:00:00Z');
      const staleUpdatedAt = new Date(now.getTime() - 10 * 60 * 1000);
      const recentUpdatedAt = new Date(now.getTime() - 60 * 1000);

      const rows: Array<[string, string, string, string | null, Date, Date, number, number, Date, Date, Date | null]> = [
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

      const toSqlLiteral = (value: string | number | Date | null) => {
        if (value === null) {
          return 'NULL';
        }
        if (value instanceof Date) {
          return `TIMESTAMPTZ '${value.toISOString()}'`;
        }
        if (typeof value === 'number') {
          return value.toString();
        }
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
        .getRawOne<{ deletedAt: Date | null }>();
      const activeClient = await repository
        .createQueryBuilder('client')
        .select('client.deletedAt', 'deletedAt')
        .where('client.address = :address', { address: 'addr-fresh' })
        .andWhere('client.clientName = :clientName', { clientName: 'worker-fresh' })
        .andWhere('client.sessionId = :sessionId', { sessionId: 'sess0002' })
        .getRawOne<{ deletedAt: Date | null }>();
      const alreadyDeleted = await repository
        .createQueryBuilder('client')
        .withDeleted()
        .select('client.deletedAt', 'deletedAt')
        .where('client.address = :address', { address: 'addr-deleted' })
        .andWhere('client.clientName = :clientName', { clientName: 'worker-deleted' })
        .andWhere('client.sessionId = :sessionId', { sessionId: 'sess0003' })
        .getRawOne<{ deletedAt: Date | null }>();

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
      const now = new Date('2024-06-01T12:00:00Z');
      const earlier = new Date('2024-06-01T10:00:00Z');

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
        // Date columns can come back as either Date or string depending on
        // the driver — normalize both before compare.
        const startA = new Date(lightRow.startTime as any).getTime();
        const startB = new Date(legacyRow!.startTime as any).getTime();
        expect(startA).toBe(startB);
        const upA = new Date(lightRow.updatedAt as any).getTime();
        const upB = new Date(legacyRow!.updatedAt as any).getTime();
        expect(upA).toBe(upB);
      }
    });

    it('excludes soft-deleted rows (deletedAt IS NULL) just like getByAddress default', async () => {
      const repo = dataSource.getRepository(ClientEntity);
      const now = new Date('2024-06-01T12:00:00Z');

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
