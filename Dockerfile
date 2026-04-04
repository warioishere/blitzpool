############################
# Docker build environment #
############################
FROM node:22.11.0-bookworm-slim AS build

RUN apt-get update \
    && apt-get upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 build-essential cmake curl ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build
COPY . .
RUN npm install && npm run build

############################
# Docker final environment #
############################
FROM node:22.11.0-bookworm-slim

# Install jemalloc to replace glibc malloc — prevents RSS growth from
# memory fragmentation caused by frequent small alloc/free cycles
# (pg driver query buffers, 600+ stratum connection buffers)
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libjemalloc2 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

# Expose ports for Stratum (standard + high-diff), JDP, and API
EXPOSE 3333 3334 3335 3339

WORKDIR /public-pool

# Copy production artifacts
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package*.json ./

CMD ["/usr/local/bin/node", "--max-old-space-size=1536", "dist/main"]
