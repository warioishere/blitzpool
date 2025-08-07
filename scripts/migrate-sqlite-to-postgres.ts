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
  const sqliteDataSource = new DataSource({
    type: 'sqlite',
    database: './DB/public-pool.sqlite',
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

    for (const entity of entities) {
      const sqliteRepo = sqliteDataSource.getRepository(entity);
      const pgRepo = postgresDataSource.getRepository(entity);
      const records = await sqliteRepo.find();
      if (records.length > 0) {
        await pgRepo.save(records);
      }
      console.log(`Migrated ${records.length} ${entity.name} records`);
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
