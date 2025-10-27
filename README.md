# ⚡️ BlitzPool – Bitcoin Mining Pool

Welcome to **BlitzPool**, a lightweight and open-source Bitcoin mining pool based on the [public-pool](https://github.com/benjamin-wilson/public-pool) project – extended with powerful new features and real-world integrations.

Current Version: **v1.3.5**

🌐 **Live Pool:** [https://blitzpool.yourdevice.ch/#/](https://blitzpool.yourdevice.ch/#/)

---

## ✨ What's Special About BlitzPool?

BlitzPool extends the original `public-pool` implementation in multiple ways to enhance usability, automation, and miner transparency:

### ✅ Core Features
- Lightweight, performant Node.js mining pool
- Full support for Bitcoin mainnet
- Stratum V1 protocol support
- Optional dedicated high-difficulty Stratum listener (port 3339 by default) that starts at difficulty 128000 but still participates in the usual automatic difficulty retargeting.
- Optimized for low-latency share submission with Nagle’s algorithm disabled by default.
- Includes further performance improvements like UTF-8 socket encoding, cached network selection, and efficient big number handling.
- Supports Extranonce Subscribe (XNSub) for dynamic extranonce updates
- loads of Telegram Bot Commands to get basic mining infos

### 🚀 Extended Features by BlitzPool

- Dual-port Stratum service with configurable baseline difficulties via `STRATUM_START_DIFFICULTY` and `STRATUM_HIGH_DIFF_START_DIFFICULTY`, plus an optional high-difficulty listener bound to `STRATUM_HIGH_DIFF_PORT` (default `3339`) that still uses the adaptive difficulty controls once clients start submitting shares.

### 🤖 Telegram Bot Commands

The BlitzPool Telegram bot offers real-time interaction and notification options via the following commands:
Command	Description
- /start	            Displays a welcome message and usage instructions
- /subscribe	        Subscribe to receive block found notifications for your mining address
- /subscribe_bestdiff	Toggle Best-Diff notifications on or off (default: on)
- /difficulty	        Shows the current Bitcoin network difficulty
- /next_difficulty	    Estimates the next network difficulty adjustment
- /stats	            Displays detailed mining stats for your subscribed Bitcoin address
- /poolhashrate          Shows the current pool hashrate

- ➡️ Subscriptions are address-based and persistent – no account or login needed.
- ➡️ For Stats, worker addresse need to be given on every command. 
- ➡️ btc worker addresse can be send encrypted with an own tool, pls see next steps:

#### 🔐 Encrypted Address Tracking
- Subscribe with **encrypted BTC addresses** for enhanced privacy
- Addresses are decrypted internally and securely matched to your mining activity

Use our Encryption tool for btc worker addresses here:

https://github.com/warioishere/blitzpool-message-encryptor-for-TG

### 📢 NTFY Notifications

BlitzPool can mirror its Telegram bot interactions over [ntfy](https://ntfy.sh/) topics.
Enable the service by setting the following optional environment variables:

```
NTFY_SERVER_URL=<https://your-ntfy-server>
NTFY_ACCESS_TOKEN=<token if required>
NTFY_TOPIC_PREFIX=<optional prefix>
NTFY_DIFF_NOTIFICATIONS=true   # publish best-diff alerts
```

On startup the pool subscribes to topics for all known BTC addresses using the
`<prefix><address>` convention. Post commands like `/subscribe` or `/stats` to the
topic of your address and the service will reply on the same channel:

```
curl -d /stats $NTFY_SERVER_URL/myPrefix1ABC...
curl -d "/subscribe 1DEF..." $NTFY_SERVER_URL/myPrefix1ABC...
```

### 🌍 GeoIP service

BlitzPool enriches peer information using the free [ip-api.com](https://ip-api.com) geolocation service to resolve city and country details. Lookups are cached for ten minutes and automatically refreshed to keep data current. No configuration is required.

#### 🛠️ Extra Services
- Integrated `blockTemplateInterval` configuration
- Hashrate corrections and updated statistics endpoints
- Extended `/api/info/chart` endpoint with a `range` query supporting `1d` and `1m`
- Pool hashrate statistics are kept for one month
- Worker shares and total shares per address are kept for six months while session details are pruned after one day
- Example: `GET /api/info/chart?range=1m` returns one month of pool hashrate data (defaults to `1d`)
- Telegram bot subscriptions managed via a custom ORM
- New `/api/info/shares` endpoint provides pool-wide accepted and rejected share totals
- New `/api/info/rejected` endpoint lists rejected share reasons pool-wide (supports `range=1d|3d|7d`)
- New `/api/client/<btc_address>/rejected` shows rejected reasons for a specific address with per-reason share counts and diff-1 weighted totals (supports `range=1d|3d|7d`)
- New `/api/info/accepted` endpoint lists pool-wide accepted share counts per 10-minute slot (supports `range=1d|3d|7d`)
- New `/api/client/<btc_address>/accepted` shows diff-1 weighted accepted share counts for a specific address per 10-minute slot
- Old jobs are cleaned after 90 seconds by default (`JOB_RETENTION_MS` can adjust this)
- Desired share rate per worker can be tuned with `TARGET_SHARES_PER_MINUTE` (default `6`)
- How often miners are checked for new difficulty can be set via `DIFFICULTY_CHECK_INTERVAL_MS` (default `60000` ms)

## 🗃️ Running BlitzPool with Postgres

SQLite continues to be the default for development and lightweight installs. To stay on SQLite, keep `DB_TYPE` unset (or explicitly set it to `sqlite`) and continue mounting `./DB/public-pool.sqlite` inside your containers. No schema changes are required for this path.

For production we recommend switching to Postgres for better concurrency, durability, and operational tooling. Two ready-made Docker Compose stacks are provided:

- `docker-compose-mainnet-pg.yml`
- `docker-compose-mainnet-pg_pm2.yml`

Each stack provisions a managed `postgres` service, waits for it to become healthy, and mounts persistent data under `./full-setup/data/mainnet/public-pool/pg`. The Postgres credentials are injected via environment variables (`PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`, `PG_SSL`).

### Prerequisites

1. Ensure Docker volumes under `full-setup/data/<network>/public-pool/pg` exist (`./full-setup/prepare.sh` will create them automatically).
2. Provide Postgres credentials via `.env`, `docker compose --env-file`, or Docker secrets.
3. Run the Nest migrations at least once (the compose stacks set `DB_RUN_MIGRATIONS=true` to run them automatically on boot).

When `DB_TYPE=postgres` and `DB_RUN_MIGRATIONS=true`, BlitzPool now runs both the TypeORM schema migrations and the SQLite→Postgres data copy on startup. The automatic copy skips itself if the Postgres tables already contain rows or the SQLite file is missing. Set `DB_MIGRATE_SQLITE_ON_BOOT=false` if you prefer to invoke `npm run migrate:sqlite-to-pg` manually.

### Selecting the database driver

- **Production Postgres:** set `DB_TYPE=postgres` and populate the `PG_*` variables. The app disables `synchronize`, applies migrations from `dist/migrations`, and skips SQLite-specific PRAGMAs.
- **Local development/tests:** keep `DB_TYPE` empty or `sqlite` to continue using the bundled SQLite database at `./DB/public-pool.sqlite`. Jest tests automatically exercise both drivers where applicable.
- You can switch between drivers by updating the env file and restarting the service. Existing SQLite installs can remain on SQLite indefinitely; no forced migration is required.

If you would like the Postgres deployment to mirror SQLite's automatic schema management, set `DB_AUTO_SYNCHRONIZE=true`. The primary instance (`NODE_APP_INSTANCE=0` or unset) will invoke `dataSource.synchronize()` once at boot after migrations run. Leave the flag unset to continue relying solely on migrations.

## 🔄 Migrating existing SQLite data to Postgres

Existing pools can migrate their on-disk SQLite database by following these steps:

1. **Plan downtime and back up data.** Stop the pool to prevent concurrent writes, copy `DB/public-pool.sqlite`, and (if Postgres already contains data) take a database snapshot so you can roll back cleanly.
2. **Provision Postgres and run the schema migrations.** The Docker Compose stacks set `DB_RUN_MIGRATIONS=true`, or you can run the Nest app once with that environment variable enabled to bootstrap the schema before copying any rows.
3. **Execute a dry run** to confirm connectivity and row counts without writing data:
   ```bash
   PG_HOST=localhost PG_PORT=5432 PG_USER=pool PG_PASSWORD=secret PG_DATABASE=public_pool \
   npm run migrate:sqlite-to-pg -- --dry-run
   ```
4. **Run the live migration** after confirming the dry run. The script copies each table in dependency order, preserves timestamps, and resets Postgres sequences so new rows continue incrementing correctly:
   ```bash
   npm run migrate:sqlite-to-pg -- --batch-size 1000
   ```
   Use `--sqlite <path>` if your SQLite file lives somewhere other than the default `./DB/public-pool.sqlite`.

If the migration fails midway, drop/restore the Postgres database from the backups taken in step 1 and re-run the script. The SQLite source is never modified, so replays are safe once the target has been reset. After a successful run, point your deployment at the new Postgres credentials (`DB_TYPE=postgres`, `PG_*` variables) and start the services. The resulting Postgres data will live under `full-setup/data/<network>/public-pool/pg` when using the provided compose stacks. Operators who previously mounted `db/pg/<network>` should move or copy their existing data into the new `full-setup/data/<network>/public-pool/pg` path before restarting.

## API

- `GET /api/info/chart?range=1d|1m` – Returns pool hashrate statistics.
- `GET /api/info/shares` – Provides pool-wide accepted and rejected share totals.
- `GET /api/info/rejected?range=1d|3d|7d` – Lists rejected share reasons pool-wide (difficulty weighted).
- `GET /api/info/accepted?range=1d|3d|7d` – Lists accepted share counts pool-wide per 10-minute slot.
- `GET /api/info/block-template` – Returns the current block template used for mining.
- `GET /api/info/core` – returns Bitcoin Core’s getnetworkinfo output (version, connections, warnings, etc.).
- `GET /api/info/version` – Returns the BlitzPool version.
- `GET /api/client/<btc_address>/rejected?range=1d|3d|7d` – Returns per 10-minute slot each rejected reason with its share count and diff-1 weighted total (`diffMinusOne`).
- `GET /api/client/<btc_address>/accepted?range=1d|3d|7d` – Shows diff-1 weighted accepted share counts for a specific address per 10-minute slot.
- `GET /api/client/<btc_address>/block-template` – Returns the block template a miner would use, including the coinbase transaction paying to the specified address. The response provides a human‑readable `blockTemplate` and the raw serialized `blockHex`.

#### Blitzpool-UI

Blitzpool UI can be found here:

https://github.com/warioishere/blitzpool-ui/tree/blitzpool-ui-master

Blitzpool UI has additional Features to show

- total Shares per address
- total shares per Worker

---
💬 Contact

For updates, support, and to join the community, reach out via:

    Matrix: @blitzpool:matrix.yourdevice.ch

    Telegram: https://t.me/blitzpool_official_switzerland

🙏 Credits

This project is a fork of the excellent public-pool by benjamin-wilson, extended and maintained by the BlitzPool team at yourdevice.ch.




