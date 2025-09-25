# Full Setup for public pool

This setup provides a docker-compose setup consisting of Bitcoin Core Node and Public-Pool running in Mainnet or Testnet.

It exposes following ports:

- `8332/18332` Bitcoin RPC on `localhost`
- `8333/18333` Bitcoin peering on `0.0.0.0`
- `3333/13333` Public-Pool Stratum port on `0.0.0.0`
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

To start the setup in foreground mode:

```
docker compose -f docker-compose-mainnet.yml up
```

To run the setup in detached / background mode use `up -d`.

In detached mode logs can be watched with:
```
docker compose -f docker-compose-mainnet.yml logs --tail 100 -f
```

# Stopping the setup

To stop the setup use:

```
docker compose -f docker-compose-mainnet.yml down
```

## Migrating existing SQLite data to Postgres

If you are upgrading an existing BlitzPool deployment from SQLite to Postgres, stop the stack, back up `DB/public-pool.sqlite`,
and restore your Postgres database from a snapshot if one exists. Run the schema migrations (the full-setup compose files enable
`DB_RUN_MIGRATIONS=true` automatically) and then execute the migration script from the repository root:

```bash
PG_HOST=localhost PG_PORT=5432 PG_USER=pool PG_PASSWORD=secret PG_DATABASE=public_pool \
npm run migrate:sqlite-to-pg
```

Add `--dry-run` first if you want to verify the connection without writing data. Should the migration encounter an error, drop
the Postgres database and restore from the backup you created before rerunning the script.

# Regtest

After running the `regtest` setup a couple of blocks need to be generated:

```bash
# create wallet
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest createwallet "regtestwallet"

# generate 101 blocks
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest  -generate 101
```
