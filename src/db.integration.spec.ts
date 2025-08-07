import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AddressSettingsEntity } from './ORM/address-settings/address-settings.entity';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import * as fs from 'fs';
import * as path from 'path';

describe('Database integration', () => {
  let repo: Repository<AddressSettingsEntity>;
  let container: StartedTestContainer | undefined;
  let moduleRef;

  beforeAll(async () => {
    const dbType = process.env.DB_TYPE || 'sqlite';
    let config: any;

    if (dbType === 'postgres') {
      container = await new GenericContainer('postgres:17')
        .withEnvironment({
          POSTGRES_USER: 'blitzpool',
          POSTGRES_PASSWORD: 'blitzpool',
          POSTGRES_DB: 'blitzpool',
        })
        .withExposedPorts(5432)
        .start();

      process.env.DB_HOST = container.getHost();
      process.env.DB_PORT = container.getMappedPort(5432).toString();
      process.env.DB_USER = 'blitzpool';
      process.env.DB_PASSWORD = 'blitzpool';
      process.env.DB_NAME = 'blitzpool';

      config = {
        type: 'postgres',
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT!, 10),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        synchronize: true,
        autoLoadEntities: true,
      };
    } else {
      const dbDir = path.resolve(__dirname, '../DB');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir);
      }
      config = {
        type: 'sqlite',
        database: path.join(dbDir, 'test-db.sqlite'),
        synchronize: true,
        autoLoadEntities: true,
      };
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(config),
        TypeOrmModule.forFeature([AddressSettingsEntity]),
      ],
    }).compile();

    repo = moduleRef.get(getRepositoryToken(AddressSettingsEntity)) as Repository<AddressSettingsEntity>;
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    if (container) {
      await container.stop();
    }
  });

  it('saves and retrieves an entity', async () => {
    const testAddress = 'test-address';
    const entity = repo.create({ address: testAddress, shares: 1, bestDifficulty: 0 });
    await repo.save(entity);

    const found = await repo.findOneBy({ address: testAddress });
    expect(found).toBeDefined();
    expect(found?.shares).toBe(1);
  });
});
