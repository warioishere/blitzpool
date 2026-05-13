############################
# Bun-native build for the blitzpool main process.
#
# Why Bun:
#   - JavaScriptCore JIT + Zig-native HTTP / fs / crypto
#   - ~30-50 % lower CPU vs Node on our workload
#   - 10x faster `bun install`
#
# Why this file exists alongside Dockerfile.node:
#   - The Bun port is still experimental (branch `experiment/bun-runtime`).
#   - One blocker (zeromq → uv_async_init, oven-sh/bun#18546) is now
#     side-stepped by the external `zmq-sidecar` service which receives
#     bitcoind ZMQ messages and re-publishes to Redis pub/sub. The pool
#     reads the Redis channel and never imports zeromq itself.
#   - Dockerfile.node is kept as a 1-line fallback (`docker build -f Dockerfile.node`).
############################

############################
# Stage 1 — install deps (with native build toolchain present)
############################
FROM oven/bun:1.3-alpine AS build

# zeromq's NAPI is NOT loaded by the pool when BLOCK_NOTIFY_SOURCE=redis-pubsub,
# but `bun install` still tries to fetch its prebuild during dependency setup.
# The alpine base needs build-tools for any package that falls back to a
# source build.  Keep the install footprint small — these tools are stripped
# in stage 2 anyway.
RUN apk add --no-cache python3 make g++ cmake

WORKDIR /build

# Copy manifests first so the install layer caches independently of source.
# bun.lock pins every dep to an exact version — critical for reproducible
# builds. Without it, Bun resolves at install time and we can drift onto a
# newer typescript / @types/node / @types/cron / etc. that breaks our
# tsc compile.
COPY package.json bun.lock ./
COPY patches ./patches

# `bun install` is 7-10x faster than `npm install` for this dep set.
# --frozen-lockfile pins to bun.lock (refuses to update).
# --ignore-scripts is critical here: zeromq's install script invokes
# uv_async_init which crashes Bun (oven-sh/bun#18546). The package is
# still extracted into node_modules; we just don't build its native
# prebuild. That's fine because BLOCK_NOTIFY_SOURCE=redis-pubsub never
# imports zeromq from the pool (the sidecar handles ZMQ instead).
RUN bun install --no-progress --ignore-scripts --frozen-lockfile

# Apply our patches explicitly since --ignore-scripts also skipped our
# own postinstall (patch-package).
RUN bunx patch-package

COPY . .

# Compile TypeScript → dist/ via NestJS CLI (which wraps tsc with
# our nest-cli.json config). The compile itself runs under Bun's
# JS runtime which is fine — tsc is pure JS, no native bindings.
RUN bunx nest build

############################
# Stage 2 — production image
############################
FROM oven/bun:1.3-alpine

# Health-check & debug helpers
RUN apk add --no-cache curl

# Stratum ports + API
#   3333 — V1 (group-solo shares this port; routing is address-driven)
#   3334 — REST API
#   3335 — V1 TLS
#   3339 — V2
#   3340 — PPLNS
EXPOSE 3333 3334 3335 3339 3340

WORKDIR /public-pool

# We pre-compile TS → dist/ with `tsc` (via `nest build`) in the build
# stage rather than running TS source directly through Bun. Reason:
# Bun's per-file TS transpiler operates in isolatedModules mode and
# can't tell whether a cross-module import is type-only without the
# full type graph. NestJS code has many `export interface` / `export type`
# alongside values; running source directly produces runtime
# `SyntaxError: Export named 'X' not found` for every type-only import.
# `tsc` has the type graph, erases type imports correctly, and the
# resulting JS runs on Bun cleanly.
#
# Runtime CPU/IO benefits of Bun apply equally to compiled JS — we
# only lose the "no build step" sugar, which is a fair trade.
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json

# Run the compiled main entry on Bun.
CMD ["bun", "run", "dist/main.js"]
