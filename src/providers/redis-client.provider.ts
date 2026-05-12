// ── Redis Client Provider ──────────────────────────────────────────
//
// Dedicated Redis client, separate from the `@nestjs/cache-manager`
// stack. Why split:
//
//   - cache-manager v7 abandoned the v5-style `store.client` escape
//     hatch we used to reach Redis primitives (ZADD, HGETALL, SCAN, …).
//     v7 sits on keyv adapters and only exposes the cache contract
//     (get/set/del/wrap). We can't get a raw client from it.
//
//   - Even ignoring the API change, treating Redis as a database
//     (PPLNS window, group-solo state, statistics buckets) is a
//     different concern from "cache layer in front of slow ops".
//     One client for each role keeps DI graphs honest.
//
// Use:
//
//   constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClientType) {}
//
// Connection is opened in onModuleInit, and properly closed via the
// NestJS shutdown hook (`onModuleDestroy`) so container restarts
// don't leak FDs. Null-safe: when REDIS_HOST is unset, the provider
// returns null so callers can short-circuit (matches existing
// in-memory-fallback behaviour in the legacy cache code).

import { Logger, OnModuleDestroy, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const log = new Logger('RedisClient');

class RedisClientLifecycle implements OnModuleDestroy {
  constructor(private readonly client: RedisClientType | null) {}
  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.isOpen) {
      try {
        await this.client.quit();
      } catch (e) {
        log.warn(`Graceful quit failed: ${(e as Error).message}`);
      }
    }
  }
}

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: async (configService: ConfigService): Promise<RedisClientType | null> => {
    const host = configService.get<string>('REDIS_HOST');
    if (!host || host.length === 0) {
      log.log('REDIS_HOST unset — Redis client unavailable (in-memory fallback in services)');
      return null;
    }
    const port = parseInt(configService.get<string>('REDIS_PORT') ?? '6379', 10);
    const password = configService.get<string>('REDIS_PASSWORD');
    const db = parseInt(configService.get<string>('REDIS_DB') ?? '0', 10);

    const url = `redis://${password ? `:${encodeURIComponent(password)}@` : ''}${host}:${port}/${db}`;
    const client = createClient({ url }) as RedisClientType;
    client.on('error', (e) => log.error(`error: ${(e as Error).message}`));
    client.on('reconnecting', () => log.warn('reconnecting'));
    client.on('ready', () => log.log(`ready → ${host}:${port}/${db}`));

    try {
      await client.connect();
    } catch (e) {
      log.error(`connect failed: ${(e as Error).message} — services using REDIS_CLIENT will get null`);
      return null;
    }

    // Lifecycle hook stashed on the client so NestJS's onModuleDestroy
    // can pick it up. We attach to the client object so we don't have
    // to register a second provider.
    (client as any).__lifecycle = new RedisClientLifecycle(client);
    return client;
  },
};
