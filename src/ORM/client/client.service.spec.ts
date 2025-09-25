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
