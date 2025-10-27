# Full Setup for public pool

This setup provides a docker-compose setup consisting of Bitcoin Core Node and Public-Pool running in Mainnet or Testnet.

It exposes following ports:

- `8332/18332` Bitcoin RPC on `localhost`
- `8333/18333` Bitcoin peering on `0.0.0.0`
- `3333/13333` Public-Pool Stratum port on `0.0.0.0`
- `3339/13339` Public-Pool high-difficulty Stratum port on `0.0.0.0`
- `3334/13334` Public-Pool API port on `localhost`

The docker-compose setups for Mainnet and Testnet can be run in parallel without any problems.

# Building Images

The images are built with

```
docker compose -f docker-compose-mainnet.yml build
```

Instead of `-mainnet` you can use `-testnet` for Testnet

# Preparing directories

Before starting the setup, directories need to be created.

```
sudo ./prepare.sh
```

# Config files

There are 4 config files for Mainnet and Testnet

`mainnet`:
- `public-pool-mainnet.env`
- `bitcoin-mainnet.conf`

`testnet`:
- `public-pool-testnet.env`
- `bitcoin-testnet.conf`

**note: pruning (`prune=550`) is enabled by default in the config**
# Running the setup

To start the setup in foreground mode with the legacy SQLite backend:

```
docker compose -f docker-compose-mainnet.yml up
```

To run the Postgres variant (recommended for production) use the matching compose file:

```
docker compose -f docker-compose-mainnet-pg.yml up
```

Both versions accept `up -d` for detached mode. Tail logs with the corresponding file, e.g. `docker compose -f docker-compose-mainnet-pg.yml logs --tail 100 -f`.

# Stopping the setup

Stop the stack with the same compose file you used for `up`:

```
docker compose -f docker-compose-mainnet.yml down
```

or

```
docker compose -f docker-compose-mainnet-pg.yml down
```

Postgres data persists under `./data/<network>/public-pool/pg`; SQLite remains stored at `../DB/public-pool.sqlite` if you stay on the legacy backend.

## Choosing your database backend

- Keep `DB_TYPE` unset or `sqlite` to continue using the bundled SQLite database. This is convenient for tests and low-resource deployments.
- Set `DB_TYPE=postgres` and provide the `PG_*` environment variables (see `blitzpool-postgres.env`) to switch to Postgres. The Postgres compose files set these defaults and wait for the database to become healthy before starting BlitzPool.
- You can switch between drivers by editing the env file and restarting the services. No migration is required unless you want to move existing data.

## Migrating existing SQLite data to Postgres

If you are upgrading an existing BlitzPool deployment from SQLite to Postgres, stop the stack, back up `DB/public-pool.sqlite`, and take a Postgres snapshot. With `DB_RUN_MIGRATIONS=true` the Postgres compose files now run both the TypeORM schema migrations and the SQLite→Postgres data copy automatically at startup, skipping themselves if the database already contains rows. Set `DB_MIGRATE_SQLITE_ON_BOOT=false` if you prefer to run the migration script manually:

```bash
PG_HOST=localhost PG_PORT=5432 PG_USER=pool PG_PASSWORD=secret PG_DATABASE=public_pool \
npm run migrate:sqlite-to-pg -- --batch-size 1000
```

Add `--dry-run` first if you want to verify the connection without writing data. Should the migration encounter an error, drop the Postgres database and restore from the backups you created before rerunning the script.

Deployments that were already using a Postgres container under `../db/pg/<network>` should relocate or bind-mount their existing data into `./data/<network>/public-pool/pg` before bringing the stack back online.

# Regtest

After running the `regtest` setup a couple of blocks need to be generated:

```bash
# create wallet
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest createwallet "regtestwallet"

# generate 101 blocks
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest  -generate 101
```
