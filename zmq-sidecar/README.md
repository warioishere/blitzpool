# zmq-sidecar

Tiny Node.js process that bridges bitcoind's ZMQ `hashblock` topic to a
Redis pub/sub channel.

## Why

`zeromq` (NAPI) calls `uv_async_init` which Bun doesn't yet implement
(tracked in [oven-sh/bun#18546](https://github.com/oven-sh/bun/issues/18546)).
The main pool wants to run on Bun. By moving the ZMQ subscription into
this 80-LOC Node sidecar and re-publishing block notifications to Redis
(which Bun supports fine), the pool can be Bun-native while still
getting sub-second block-found latency from bitcoind.

Also useful even without the Bun angle:

- ZMQ disconnects no longer crash the pool
- the sidecar restarts independently
- multiple pool instances can fan out off one bitcoind ZMQ feed

## Channels

- `pool:bitcoind:newblock` — every received bitcoind `hashblock` is
  re-published here as the 64-char hex hash
- `pool:bitcoind:newblock:heartbeat` — emitted every 60 s with the
  current unix timestamp (ms). Pool side can warn if it sees no
  heartbeat for >90 s

Both channel names are configurable via `BLOCK_NOTIFY_CHANNEL`.

## Environment

| Var | Default | Notes |
|---|---|---|
| `BITCOIN_ZMQ_HOST` | `tcp://bitcoind:28332` | bitcoind ZMQ pub endpoint |
| `REDIS_HOST` | `localhost` | |
| `REDIS_PORT` | `6379` | |
| `REDIS_PASSWORD` | — | optional |
| `BLOCK_NOTIFY_CHANNEL` | `pool:bitcoind:newblock` | prefix; heartbeat is `<channel>:heartbeat` |

## Run

```bash
npm install
npm start
```

or via Docker:

```bash
docker build -t blitzpool-zmq-sidecar .
docker run --rm \
  -e BITCOIN_ZMQ_HOST=tcp://bitcoind:28332 \
  -e REDIS_HOST=redis \
  blitzpool-zmq-sidecar
```
