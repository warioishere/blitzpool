# Bun Runtime Migration — Phase 1 Experiment Results

**Branch**: `experiment/bun-runtime` (off `blitzpool-master` `d2a2b7c`)
**Tested**: 2026-05-12 with Bun `1.3.13`, Node baseline `22.22.2`
**Outcome**: ⛔ **Blocked** — `zeromq` 6.0.0-beta.19 crashes Bun (missing `uv_async_init` libuv shim)

---

## What we tested

A drop-in replacement of Node.js + npm with Bun, on the existing blitzpool
codebase. Goal: see if Bun runs our NestJS + TypeORM + Redis + SV2 stack
without code changes, and what the speed/memory gains would be.

---

## What worked

| Step | Tool | Time | Notes |
|---|---|---:|---|
| Dependency install | `bun install` | **6.2 s** | vs `npm install` ~40-60 s (**~7-10× faster**) |
| `postinstall` (patch-package) | `bun run postinstall` | ~1 s | Patch for `rpc-bitcoin@2.0.0` applied cleanly |
| TypeScript typecheck | `bunx tsc --noEmit` | **3.1 s** | Zero errors |
| Nest build | `bunx nest build` | **6.6 s** | `dist/` produced cleanly |
| Jest test suite (excl. regtest) | `bunx jest --runInBand` | 38.7 s | **858/864 tests passing** (6 skipped, same as Node) |

All non-ZMQ native bindings import cleanly on Bun:

- ✅ `sqlite3` (NAPI / node-gyp)
- ✅ `tiny-secp256k1` (NAPI / libsecp256k1)
- ✅ `pg` (pure JS, but bundled native parser used internally)
- ✅ `firebase-admin` (heavy multi-binding package)
- ✅ `bitcoinjs-lib`, `bitcoinjs-message`, `@scure/btc-signer`

---

## What failed

**`zeromq` 6.0.0-beta.19 crashes Bun at import time.**

```
panic(main thread): unsupported uv function: uv_async_init
https://github.com/oven-sh/bun/issues/18546
```

Bun reimplements libuv (Node's I/O backend) in Zig. Several libuv functions
are not yet ported — `uv_async_init` is one of them. The `zeromq` NAPI module
calls `uv_async_init` during `dlopen` to set up its async-IPC mechanism, and
that call hits Bun's "unsupported function" path which immediately panics
the process.

The blocking call site in our code is exactly one file:

```ts
// src/services/bitcoin-rpc.service.ts:6
import * as zmq from 'zeromq';
```

We use ZMQ to subscribe to bitcoind's `pubrawblock` / `pubhashblock` topic —
the real-time block-found notification stream from Bitcoin Core. Replacing
that with RPC polling would noticeably degrade our orphan-rate (we'd lose
the sub-second block-change latency).

---

## Upstream status

- **Bun issue [oven-sh/bun#18546](https://github.com/oven-sh/bun/issues/18546)** — "Implement libuv functions"
- **State**: Open, last updated 2026-04-25
- No specific timeline for `uv_async_init` coverage.
- Bun maintainers are actively expanding libuv coverage; this one
  hasn't been prioritised yet because it's primarily needed by
  inter-thread C-side notification (i.e. zeromq, some FFI bindings).

---

## Options going forward

| Option | Effort | Trade-off |
|---|---|---|
| **Wait** for Bun to add `uv_async_init` | 0 (just track issue) | Indeterminate timeline |
| Replace ZMQ with bitcoind RPC polling | ~1 day | Worse orphan rate (sec-scale vs ms-scale block-change latency) |
| Move ZMQ subscriber to standalone Node subprocess + IPC to Bun pool | ~2-3 days | Over-engineered; we'd run two runtimes |
| Use a pure-JS ZMQ client (e.g. `zmq.js`) | ~half day | Lower-quality library; uncertain protocol compatibility with bitcoind |

---

## Recommendation

**Park.** We've identified a real blocker we can't paper over without
significant work or a feature degradation. The win profile (~30-50% CPU
reduction estimate) doesn't justify the engineering effort to work around
ZMQ. Track Bun issue #18546 and revisit when `uv_async_init` is shipped.

The `experiment/bun-runtime` branch is kept as the documentation artefact —
anyone curious can reproduce the result in <10 minutes by checking out
the branch and running `bun install && bun run bun-isolate-test.ts`.

When the Bun issue is closed, the actual migration would be:
1. `bun install` (already verified — works)
2. Switch Dockerfile from `node:22-alpine` to `oven/bun:1-alpine`
3. Change CMD from `node dist/main` to `bun dist/main.js`
4. Smoke-test on test-pool (`172.16.0.21`)
5. Deploy to prod

Estimated cutover effort once Bun supports the function: **~2-4 hours**.
