import { ConfigService } from '@nestjs/config';

import { buildDatabaseConfig } from './database.config';

describe('buildDatabaseConfig', () => {
    it('returns sqlite configuration by default', () => {
        const config = buildDatabaseConfig(new ConfigService());

        expect(config).toMatchObject({
            type: 'sqlite',
            synchronize: true,
            autoLoadEntities: true,
            logging: false,
        });
    });

    it('returns postgres configuration when DB_TYPE=postgres', () => {
        const configService = new ConfigService({
            DB_TYPE: 'postgres',
            PG_HOST: 'postgres-host',
            PG_PORT: '6543',
            PG_USER: 'postgres-user',
            PG_PASSWORD: 'postgres-password',
            PG_DATABASE: 'postgres-db',
            PG_SSL: 'true',
            DB_RUN_MIGRATIONS: 'true',
        });

        const config = buildDatabaseConfig(configService);

        expect(config).toMatchObject({
            type: 'postgres',
            host: 'postgres-host',
            port: 6543,
            username: 'postgres-user',
            password: 'postgres-password',
            database: 'postgres-db',
            autoLoadEntities: true,
            synchronize: false,
            ssl: true,
            migrationsRun: true,
        });

        expect(config.migrations).toBeDefined();
    });
});
