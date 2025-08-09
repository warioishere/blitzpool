import 'dotenv/config';
import path from 'path';
import { DataSource } from 'typeorm';

import { AddressSettingsEntity } from '../src/ORM/address-settings/address-settings.entity';
import { BlocksEntity } from '../src/ORM/blocks/blocks.entity';
import { ClientEntity } from '../src/ORM/client/client.entity';
import { ClientRejectedStatisticsEntity } from '../src/ORM/client-rejected-statistics/client-rejected-statistics.entity';
import { ClientStatisticsEntity } from '../src/ORM/client-statistics/client-statistics.entity';
import { ExternalSharesEntity } from '../src/ORM/external-shares/external-shares.entity';
import { PoolRejectedStatisticsEntity } from '../src/ORM/pool-rejected-statistics/pool-rejected-statistics.entity';
import { PoolShareStatisticsEntity } from '../src/ORM/pool-share-statistics/pool-share-statistics.entity';
import { RpcBlockEntity } from '../src/ORM/rpc-block/rpc-block.entity';
import { TelegramSubscriptionsEntity } from '../src/ORM/telegram-subscriptions/telegram-subscriptions.entity';

const entities = [
  AddressSettingsEntity,
  BlocksEntity,
  ClientEntity,
  ClientRejectedStatisticsEntity,
  ClientStatisticsEntity,
  ExternalSharesEntity,
  PoolRejectedStatisticsEntity,
  PoolShareStatisticsEntity,
  RpcBlockEntity,
  TelegramSubscriptionsEntity,
];

async function migrate() {
  const sqlitePath =
    process.env.SQLITE_DB_PATH || path.resolve('DB', 'public-pool.sqlite');
  console.log(`Using SQLite database at ${sqlitePath}`);

  const sqliteDataSource = new DataSource({
    type: 'sqlite',
    database: sqlitePath,
    entities,
  });

  const postgresDataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities,
    synchronize: true,
  });

  try {
    await sqliteDataSource.initialize();
    await postgresDataSource.initialize();

    const batchSize = 1000;
    for (const entity of entities) {
      try {
        const sqliteRepo = sqliteDataSource.getRepository(entity);
        const pgRepo = postgresDataSource.getRepository(entity);

        let offset = 0;
        let migratedCount = 0;
        while (true) {
          const records = await sqliteRepo.find({ skip: offset, take: batchSize });
          if (records.length === 0) break;

          await pgRepo.save(records);
          offset += records.length;
          migratedCount += records.length;
          console.log(
            `Migrated batch of ${records.length} ${entity.name} records (total: ${migratedCount})`,
          );
        }

        if (
          pgRepo.metadata.generatedColumns.some(
            (col) => col.isPrimary && col.generationStrategy === 'increment',
          )
        ) {
          const tableName = pgRepo.metadata.tableName;
          const sequenceName = `${tableName}_id_seq`;
          await pgRepo.query(
            `SELECT setval('${sequenceName}', (SELECT COALESCE(MAX(id), 0) FROM "${tableName}"));`,
          );
          console.log(`Adjusted sequence ${sequenceName} for ${entity.name}`);
        }
      } catch (err) {
        console.error(`Error migrating ${entity.name}:`, err);
      }
    }

    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await sqliteDataSource.destroy().catch(() => undefined);
    await postgresDataSource.destroy().catch(() => undefined);
  }
}

migrate();
