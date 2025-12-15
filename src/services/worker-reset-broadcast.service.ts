import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { createClient, RedisClientType } from 'redis';

/**
 * Redis pub/sub service for broadcasting worker reset events across PM2 instances.
 *
 * When /bestdiff_reset is called on one PM2 instance (instance 0 running Telegram bot),
 * this service broadcasts the reset event to all other PM2 instances so they can
 * update their in-memory worker objects accordingly.
 */
@Injectable()
export class WorkerResetBroadcastService implements OnModuleInit, OnModuleDestroy {
  private pubClient: RedisClientType | null = null;
  private subClient: RedisClientType | null = null;
  private useRedis = false;
  private resetHandlers = new Set<(address: string) => void | Promise<void>>();
  private readonly CHANNEL_NAME = 'blitzpool:worker-reset';

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Try to get Redis configuration
    const redisHost = this.configService.get<string>('REDIS_HOST');
    const redisPort = parseInt(this.configService.get<string>('REDIS_PORT') ?? '6379', 10);
    const redisPassword = this.configService.get<string>('REDIS_PASSWORD');
    const redisDb = parseInt(this.configService.get<string>('REDIS_DB') ?? '0', 10);

    if (!redisHost || redisHost.length === 0) {
      console.log('[WorkerResetBroadcast] Redis not configured, reset broadcasts disabled');
      return;
    }

    try {
      // Create dedicated Redis clients for pub/sub (cannot reuse cache client)
      const redisConfig = {
        socket: {
          host: redisHost,
          port: redisPort,
        },
        password: redisPassword && redisPassword.length > 0 ? redisPassword : undefined,
        database: redisDb,
      };

      // Publisher client
      this.pubClient = createClient(redisConfig);
      this.pubClient.on('error', (err) => {
        console.error('[WorkerResetBroadcast] Publisher error:', err);
      });
      await this.pubClient.connect();

      // Subscriber client (must be separate from publisher in Redis)
      this.subClient = createClient(redisConfig);
      this.subClient.on('error', (err) => {
        console.error('[WorkerResetBroadcast] Subscriber error:', err);
      });
      await this.subClient.connect();

      // Subscribe to reset channel
      await this.subClient.subscribe(this.CHANNEL_NAME, (message) => {
        this.handleResetMessage(message);
      });

      this.useRedis = true;
      const pm2InstanceId = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID ?? 'unknown';
      console.log(`[WorkerResetBroadcast] Initialized for PM2 instance ${pm2InstanceId}, listening on channel: ${this.CHANNEL_NAME}`);
    } catch (error) {
      console.error('[WorkerResetBroadcast] Failed to initialize Redis pub/sub:', error);
      // Clean up on failure
      if (this.pubClient) {
        try {
          await this.pubClient.quit();
        } catch {}
        this.pubClient = null;
      }
      if (this.subClient) {
        try {
          await this.subClient.quit();
        } catch {}
        this.subClient = null;
      }
      this.useRedis = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subClient) {
      try {
        await this.subClient.unsubscribe(this.CHANNEL_NAME);
        await this.subClient.quit();
      } catch (error) {
        console.error('[WorkerResetBroadcast] Error disconnecting subscriber:', error);
      }
      this.subClient = null;
    }

    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch (error) {
        console.error('[WorkerResetBroadcast] Error disconnecting publisher:', error);
      }
      this.pubClient = null;
    }

    this.resetHandlers.clear();
  }

  /**
   * Register a handler to be called when a reset event is received
   */
  public onReset(handler: (address: string) => void | Promise<void>): void {
    this.resetHandlers.add(handler);
  }

  /**
   * Broadcast a reset event for the given address to all PM2 instances
   */
  public async broadcastReset(address: string): Promise<void> {
    if (!this.useRedis || !this.pubClient) {
      console.log('[WorkerResetBroadcast] Redis not available, skipping broadcast');
      return;
    }

    try {
      const message = JSON.stringify({
        address,
        timestamp: Date.now(),
        instance: process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID ?? 'unknown',
      });

      await this.pubClient.publish(this.CHANNEL_NAME, message);
      console.log(`[WorkerResetBroadcast] Broadcasted reset for address ${address}`);
    } catch (error) {
      console.error('[WorkerResetBroadcast] Failed to broadcast reset:', error);
    }
  }

  /**
   * Handle incoming reset messages from other PM2 instances
   */
  private handleResetMessage(message: string): void {
    try {
      const data = JSON.parse(message);
      const { address, instance } = data;

      if (!address) {
        console.warn('[WorkerResetBroadcast] Received invalid reset message:', message);
        return;
      }

      const currentInstance = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.env.PM2_INSTANCE_ID ?? 'unknown';
      console.log(`[WorkerResetBroadcast] Instance ${currentInstance} received reset for address ${address} from instance ${instance}`);

      // Call all registered handlers
      for (const handler of this.resetHandlers) {
        try {
          const result = handler(address);
          if (result instanceof Promise) {
            result.catch((err) => {
              console.error('[WorkerResetBroadcast] Handler error:', err);
            });
          }
        } catch (error) {
          console.error('[WorkerResetBroadcast] Handler error:', error);
        }
      }
    } catch (error) {
      console.error('[WorkerResetBroadcast] Failed to handle reset message:', error);
    }
  }
}
