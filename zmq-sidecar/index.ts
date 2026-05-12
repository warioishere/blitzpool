// ZMQ → Redis pub/sub bridge for bitcoind block notifications.
//
// Why this sidecar exists:
//
// The Bun runtime (https://bun.sh) currently lacks the libuv function
// `uv_async_init`, which the `zeromq` NAPI module needs. That blocks
// the whole pool process from running on Bun. By isolating the ZMQ
// subscription into a tiny Node.js sidecar and re-publishing to Redis
// pub/sub (which Bun supports), the rest of the pool can migrate to
// Bun while we wait for oven-sh/bun#18546.
//
// Even without the Bun angle, this is a cleaner architecture:
//   - ZMQ disconnects don't crash the pool
//   - sidecar can be restarted independently
//   - multiple pool instances could fan out off one sidecar
//
// Wire-level: bitcoind publishes `hashblock` (32-byte big-endian hash)
// when a new block is found. We subscribe to that topic and forward
// the hash (hex) to Redis pub/sub channel `BLOCK_NOTIFY_CHANNEL`.

import * as zmq from 'zeromq';
import { createClient, type RedisClientType } from 'redis';

const ZMQ_ENDPOINT      = process.env.BITCOIN_ZMQ_HOST     ?? 'tcp://bitcoind:28332';
const REDIS_HOST        = process.env.REDIS_HOST           ?? 'localhost';
const REDIS_PORT        = parseInt(process.env.REDIS_PORT  ?? '6379', 10);
const REDIS_PASSWORD    = process.env.REDIS_PASSWORD       ?? undefined;
const CHANNEL           = process.env.BLOCK_NOTIFY_CHANNEL ?? 'pool:bitcoind:newblock';
const HEARTBEAT_CHANNEL = `${CHANNEL}:heartbeat`;
const HEARTBEAT_MS      = 60_000;

const log = (msg: string) => console.log(`[zmq-sidecar] ${msg}`);
const err = (msg: string) => console.error(`[zmq-sidecar] ${msg}`);

let redis: RedisClientType | null = null;

async function connectRedis(): Promise<RedisClientType> {
  const url = `redis://${REDIS_PASSWORD ? `:${REDIS_PASSWORD}@` : ''}${REDIS_HOST}:${REDIS_PORT}`;
  const client = createClient({ url });
  client.on('error', (e) => err(`redis error: ${(e as Error).message}`));
  client.on('reconnecting', () => log('redis reconnecting'));
  await client.connect();
  log(`redis connected → ${REDIS_HOST}:${REDIS_PORT}`);
  return client as RedisClientType;
}

async function startHeartbeat(client: RedisClientType): Promise<void> {
  // Allows the pool to detect sidecar liveness: if no heartbeat for
  // >90s, alert. Body is the unix timestamp (ms) — pool can sanity-
  // check skew if it cares.
  setInterval(async () => {
    try {
      await client.publish(HEARTBEAT_CHANNEL, String(Date.now()));
    } catch (e) {
      err(`heartbeat publish failed: ${(e as Error).message}`);
    }
  }, HEARTBEAT_MS);
}

async function listenZmq(client: RedisClientType): Promise<void> {
  const sock = new zmq.Subscriber();
  sock.connectTimeout = 1000;

  sock.events.on('connect', () => log(`ZMQ connected → ${ZMQ_ENDPOINT}`));
  sock.events.on('connect:retry', () => log('ZMQ retrying connect'));
  sock.events.on('disconnect', () => log('ZMQ disconnected'));

  sock.connect(ZMQ_ENDPOINT);
  // `hashblock` is enough — we only need the notification.
  // `rawblock` would carry the full block (~MB) which we don't need.
  sock.subscribe('hashblock');
  log(`subscribed → topic=hashblock, publishing → ${CHANNEL}`);

  for await (const [topic, message] of sock) {
    const hash = Buffer.from(message).toString('hex');
    try {
      const receivers = await client.publish(CHANNEL, hash);
      log(`block ${hash.slice(0, 16)}… → ${receivers} subscriber(s)`);
    } catch (e) {
      err(`publish failed: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  log('starting');
  redis = await connectRedis();
  void startHeartbeat(redis);
  await listenZmq(redis);
}

function shutdown(signal: string): void {
  log(`got ${signal}, shutting down`);
  redis?.quit().catch(() => undefined);
  // Give Redis 1s to close gracefully then hard-exit so the container
  // restart policy can take over fast.
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  err(`fatal: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
