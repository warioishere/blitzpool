# ⚡ Blitzpool – Non-Custodial Bitcoin Mining Pool

**Blitzpool** is an open-source Bitcoin mining pool with a single distinguishing feature: **every payout — Solo, PPLNS, Group-Solo, Blockparty — is written directly into the coinbase transaction of the block that earned it**. No pool wallet, no custody period, no FPPS-style intermediate. Your sats arrive at your address with the block itself.

Current version: **v2.2.0**

🌐 Live pool: **https://blitzpool.yourdevice.ch**

Fork of [public-pool](https://github.com/benjamin-wilson/public-pool), rebuilt around four coinbase-payout modes and a full Stratum V2 stack.

---

## What makes Blitzpool different

| | Blitzpool | Typical FPPS / PPS+ | Custodial PPLNS |
|---|---|---|---|
| Payouts go directly on-chain | ✅ same block as the find | ❌ batch cron, hours to days | ❌ threshold-based |
| Pool holds miner sats | ❌ never | ✅ between find & payout | ✅ until threshold |
| Minimum payout | *none* — it's just a coinbase output | typically 0.001 BTC+ | same |
| Share window | PPLNS 4× netdiff (anti-hop), Group-Solo PROP | FPPS contract | opaque |
| Stratum V1 | ✅ | ✅ | ✅ |
| Stratum V2 (Noise + TDP + JDP + extended channels) | ✅ | rare | almost never |
| Non-custodial Group-Solo (friends mine together, reward split on-chain) | ✅ **unique worldwide** | — | — |
| Non-custodial Blockparty (co-funded rentals, fixed-% on-chain split per member) | ✅ **unique worldwide** | — | — |

Blitzpool is (to the operator's knowledge) the first Bitcoin pool that offers **all four payout modes non-custodially over both SV1 and SV2**.

---

## The four payout modes

### 🎯 Solo

Just you versus Bitcoin. You submit shares against the full network difficulty; when your share wins, the pool relays the block and the entire coinbase goes to your address. No fee. The pool never sees the sats.

**When it fits:** big miner, wants the full reward when it hits, is fine with long dry spells between finds.

### 🔗 PPLNS (Pay Per Last N Shares)

Sliding-window pooled mining with a **multi-output coinbase** and a **signed credit/debit ledger**. Every miner in the window gets their proportional share written as their own output in the same coinbase transaction that mints the block. No pool wallet touches the sats.

- Window size: `4 × networkDifficulty` in diff-1-weighted shares
- Anti-hop by design (sliding window, not per-block reset)
- Sub-dust or weight-trimmed shares accumulate as a signed **pending credit** on the miner's ledger row; bonus recipients of the same block pick up a matching **pending debit**
- Fee is a single coinbase output to `PPLNS_FEE_ADDRESS` — exact feePercent, never padded by trim / sub-dust sweep
- Dedicated port, default `PPLNS_PORT=3340`
- HighDiff PPLNS port for rentals (Braiins/MRR/NiceHash), default `PPLNS_HIGH_DIFF_PORT=3349` — auto-enabled when PPLNS is on

**When it fits:** mid-size ASIC, wants more regular variance smoothing than Solo, still values non-custodial payouts over FPPS convenience.

#### The signed credit/debit ledger

PPLNS's non-custodial guarantee is enforced by a per-miner signed balance (`pplns_balance.balanceSats`):

- **`balanceSats > 0`** — pool owes the miner this much (pending credit, accumulated from sub-dust rounds or weight-trimmed blocks where their on-chain output didn't fit).
- **`balanceSats < 0`** — miner owes the pool this much (debit booked when they received an on-chain bonus from another miner's trimmed / sub-dust share; settled automatically the next time they mine by reducing their rawFair).
- **`balanceSats == 0`** — no open claim in either direction.

Every sat a miner earns stays with that miner. Trimmed and sub-dust sats become a *credit* for the miner who earned them; the bonus recipient of the same block picks up a matching *debit*. The fee output gets exactly `feePercent`, never padded by sweep leftovers. The sum of all balances across the whole pool stays at `0` (bounded drift of up to `numMiners` sats per block from floor-rounding).

**Abandonment:** when a miner goes dormant for `ABANDONED_BALANCE_DAYS` days (default 90 = 3 months), the daily sweep cron pair-matches their balance against abandoned counterparties (largest-credit ↔ largest-debit) and cancels both sides. Unpaired remainders stay in the ledger until a counterparty also becomes abandoned or the debitor returns. No active miner's fair share is ever touched by another miner's abandonment.

See `src/services/coinbase-distribution.ts` for the full algorithm (5 phases incl. solvency cap) and `src/services/dust-sweep.service.ts` for the pair-aware sweep.

### 👥 Group-Solo

Friends mine together as a closed group. Every block a group finds is split proportionally to each member's shares in that round, paid directly in the coinbase. **Address-driven** routing — any port works. No group-admin has access to anyone's sats.

- PROP-style: round resets on every found block
- Minimum 2 members to activate a group
- Admin-token auth (shown once on create); **email-verified invitations only** (see [Security](#security))
- Admin can kick inactive members after 14 days; pending sats redistribute to the remaining members
- Same 546-sat dust floor + coinbase-weight-budget trim as PPLNS

**When it fits:** small crew of friends wants to combine hashrate against higher variance than pure Solo, but keeps full on-chain custody.

### 🎉 Blockparty

A directed group sharing the cost of a hashpower rental. Every member contributes to a single rental-administrator address; the rented miners point at that address; when a block is found, the coinbase carries one output per member with their **fixed cut** (basis points, not work-weighted). Splits are agreed up front and signed off by every member before the party goes live.

- Fixed % per member (basis points summing to 100 % of the miner cut)
- Email-verified directed invitations; per-member token for re-confirm after admin edits splits
- Uses the shared `GROUP_FEE_ADDRESS` + `GROUP_FEE_PERCENT` lane (same as Group-Solo, independent from PPLNS)
- Routing is address-driven: any miner / rental session whose address is the party's admin gets a Blockparty coinbase on any port
- State machine: DRAFT → CONFIRMING → READY → ACTIVE → DISSOLVED (7-day dissolve cooldown so admins can't yank rentals mid-flight)
- Verified end-to-end against Bitcoin Core 29 with mixed address types (P2WPKH / P2PKH / P2TR / P2WSH / P2SH)

**When it fits:** a group co-funds a Braiins / NiceHash / MRR rental and wants the on-chain payout to land in each member's address in agreed proportions, not into a treasury wallet that someone has to redistribute.

---

## Stratum V2 support

Complete SV2 stack built in-tree:

- **Noise handshake** (Act 1 / Act 2 / transport, verified against BraiinsOS & SRI reference)
- **Standard channels** — per-miner difficulty, group channels
- **Extended channels** — extranonce rolling, merkle-root reconstruction, pool-side share validation
- **Template Distribution Protocol (TDP)** — pool-built templates
- **Job Declaration Protocol (JDP)** — miners can declare their own templates; pool pays via `SetCustomMiningJob`
- **JDP → SetCustomMiningJob bridge** — declared jobs flow to the extended-channel clients of the same address
- SipHash-2-4 verified against all 16 official test vectors
- 224 SV2 unit tests across 13 spec files

SV2 listens on the same TCP ports as SV1; protocol detection on the first byte routes the socket.

---

## Stratum endpoints

| Port | Protocol | Starting difficulty | Purpose |
|---|---|---|---|
| `3333` | SV1 / SV2 | `STRATUM_START_DIFFICULTY` (default 1000) | Default entry — Solo, Group-Solo, Blockparty |
| `3339` | SV1 / SV2 | `STRATUM_HIGH_DIFF_START_DIFFICULTY` (default 1,000,000) | Mining-rental endpoint (NiceHash, MRR, Braiins) — also the canonical Blockparty rental port |
| `3340` | SV1 / SV2 | adaptive | **PPLNS** — explicit opt-in to PPLNS payout |
| `6666` | SV1 TLS | adaptive | Encrypted Stratum (SV1 only) |
| `3337` | SV2 JDP | — | Job Declaration Protocol, when `SV2_JDP_ENABLED=true` |

Routing priority for a connecting miner:
1. **Explicit PPLNS port (3340)** → PPLNS, regardless of group / Blockparty membership
2. **Active Blockparty admin address** → Blockparty (any non-PPLNS port)
3. **Active Group-Solo membership** for the miner's BTC address → Group-Solo (any non-PPLNS port)
4. **None of the above** → Solo

Blockparty + Group-Solo are mutually exclusive per address (an address is in one or the other, never both — bidirectional collision check at create / addMember time). Address-driven means neither requires the miner to reconfigure anything; the pool looks them up by BTC address on connect and routes accordingly.

---

## Security

### Non-custodial by design

The pool's production wallets do not exist. Every block that is mined on Blitzpool has the miner-address(es) as the direct destination in the coinbase transaction. An operator can't withhold payouts — they'd have to refuse to relay the block at all, and the miner would simply submit it elsewhere.

### Email-required group + Blockparty invitations

Adding a miner to a Group-Solo group OR a Blockparty is a two-phase invitation flow:

1. Admin requests an invitation for a BTC address
2. Pool sends a token-ified link to the **verified email** bound to that address
3. The address-owner accepts (or declines) via the emailed link

The invitation token lives only in the email body. The public `/app/:address` page shows a pending-invitations banner with a **masked** email hint but **never** the token — so a visitor to a miner's public dashboard can't accept on their behalf. This closes the "silent-add" attack where an admin would otherwise redirect an unsuspecting miner's payouts into their own group.

Admin-side API endpoints strip the token too; cancellations go by `(groupId, address)`, not by token.

### Idempotent block payouts

Each block's payout bookkeeping is one Postgres transaction with a pre-check on `pplns_payout_history.(blockHeight, address)` and a unique index as defense-in-depth. Replays (process restart mid-block-find, concurrent writers racing for the same block) can't double-credit.

### Coinbase weight guard

Mainnet `bitcoin.conf` ships with `blockreservedweight=50000` WU. Blitzpool fits up to ~286 distinct miner outputs per block; additional miners accumulate in pending until the operator bumps the reservation. A capacity-alert service emails the operator (`POOL_ADMIN_EMAIL`) at 80 % / 95 % / recovery thresholds so the bump can happen before anyone is actually trimmed.

---

## Configuration

### Stratum + pool basics

| Variable | Default | Purpose |
|---|---|---|
| `STRATUM_PORT` | `3333` | Primary SV1/SV2 listener |
| `STRATUM_HIGH_DIFF_PORT` | `3339` | High-difficulty listener (mining rentals) |
| `STRATUM_TLS_PORT` | `6666` | TLS SV1 |
| `STRATUM_START_DIFFICULTY` | `1000` | Base starting diff |
| `STRATUM_HIGH_DIFF_START_DIFFICULTY` | `1000000` | High-diff starting diff |
| `TARGET_SHARES_PER_MINUTE` | `6` | Auto-retarget goal |
| `DIFFICULTY_CHECK_INTERVAL_MS` | `60000` | Retarget cadence |
| `JOB_RETENTION_MS` | `90000` | Old-job cleanup window |
| `DEV_FEE_ADDRESS` | — | Optional dev fee address for Solo mode |
| `DEV_FEE_PERCENT` | `1.5` | Dev fee % |

### PPLNS mode

| Variable | Default | Purpose |
|---|---|---|
| `PPLNS_PORT` | — | Enables PPLNS when set (suggested `3340`) |
| `PPLNS_HIGH_DIFF_PORT` | `3349` | High-difficulty PPLNS listener for rentals — auto-enabled when `PPLNS_PORT` is set. Reuses `STRATUM_HIGH_DIFF_START_DIFFICULTY` + `STRATUM_HIGH_DIFF_TARGET_SHARES_PER_MINUTE` for diff/target, `PPLNS_WARMUP_SHARES` + `PPLNS_MIN_DIFFICULTY` for ledger gates. Blocks miner-suggested-difficulty so rentals start at the configured high diff |
| `PPLNS_FEE_ADDRESS` | — | PPLNS-lane pool fee output destination |
| `PPLNS_FEE_PERCENT` | `2` | PPLNS-lane pool fee % |
| `GROUP_FEE_ADDRESS` | falls back to `PPLNS_FEE_ADDRESS` | Group-Solo + Blockparty shared-lane fee destination |
| `GROUP_FEE_PERCENT` | falls back to `PPLNS_FEE_PERCENT` | Group-Solo + Blockparty shared-lane fee % |
| `PPLNS_COINBASE_WEIGHT_BUDGET` | `50000` | Max WU reserved for coinbase outputs (must match `bitcoin.conf:blockreservedweight`) |

### Capacity monitor (email alerts)

| Variable | Default | Purpose |
|---|---|---|
| `POOL_ADMIN_EMAIL` | — | Alert recipient; unset → monitor disabled |
| `POOL_CAPACITY_ALERT_ENABLED` | `true` | Master switch |
| `POOL_CAPACITY_ALERT_THRESHOLD` | `0.8` | Warning threshold (fraction of `maxMinerOutputs`) |
| `POOL_CAPACITY_ALERT_URGENT_THRESHOLD` | `0.95` | Urgent threshold |

### SMTP (for invitations + email verification + capacity alerts)

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Nodemailer transport; all required or email features stay disabled |
| `POOL_BASE_URL` | — | Public UI URL used to build email links (`/#/email/verify/:token`, `/#/invite/:token`) |

### SV2

| Variable | Default | Purpose |
|---|---|---|
| `SV2_JDP_ENABLED` | `false` | Enable Job Declaration Protocol server |
| `SV2_JDP_PORT` | `3337` | JDP listener |

### Dust-sweep cron

| Variable | Default | Purpose |
|---|---|---|
| `DUST_SWEEP_ENABLED` | `true` | Enables daily 03:00 dust cleanup |
| `DUST_SWEEP_DORMANT_DAYS` | `30` | Pending sub-dust rows dormant for this long are absorbed to history |

### Database

See [Running Blitzpool with Postgres](#running-blitzpool-with-postgres).

---

## API

### Pool-wide

| Endpoint | Returns |
|---|---|
| `GET /api/info` | Block data, user agents, high scores, uptime |
| `GET /api/network` | Bitcoin Core `getmininginfo` (difficulty, network hashrate, …) |
| `GET /api/info/chart?range=1d\|1m` | Pool hashrate time-series |
| `GET /api/info/chart/mode/:mode?range=7d` | Per-mode (`solo` / `pplns` / `group-solo` / `blockparty`) hashrate time-series |
| `GET /api/info/chart/live?range=1h\|6h\|12h\|24h` | Live 1-min hashrate |
| `GET /api/info/shares` | Σ accepted + rejected diff-1 work, incl. `acceptedSinceBlock` (mode-agnostic, all three modes) |
| `GET /api/info/accepted?range=1d\|3d\|7d` | Accepted share counts per 10-min slot |
| `GET /api/info/rejected?range=1d\|3d\|7d` | Rejected shares per reason |
| `GET /api/info/peers` | Bitcoin Core peers enriched with geoip |
| `GET /api/info/block-template` | Current block template (solo-shaped) |
| `GET /api/info/core` | `getnetworkinfo` output |
| `GET /api/info/version` | Pool version |

### Per miner / address

| Endpoint | Returns |
|---|---|
| `GET /api/client/:address/accepted?range=1d\|3d\|7d` | Per-10-min diff-1 accepted |
| `GET /api/client/:address/rejected?range=1d\|3d\|7d` | Per-reason rejects |
| `GET /api/client/:address/block-template` | Mode-aware block template (solo / pplns-shaped / group-solo-shaped coinbase depending on the miner's mode) |
| `GET /api/pplns/mode/:address` | Which mode the miner is currently routed to: `{ mode: 'solo' \| 'pplns' \| 'group-solo' \| 'blockparty', groupId? }` |

### PPLNS

| Endpoint | Returns |
|---|---|
| `GET /api/pplns` | Pool-wide filtered info |
| `GET /api/pplns/status` | Window size, total shares, network difficulty |
| `GET /api/pplns/distribution` | Current payout distribution (addresses + percents) |
| `GET /api/pplns/fees` | Fee config (percent, address, budget) |
| `GET /api/pplns/chart?range=1d\|3d\|7d` | PPLNS-only hashrate time-series |
| `GET /api/pplns/:address` | Miner's PPLNS status (pending, total paid, window %) |
| `GET /api/pplns/:address/history` | Miner's block payout history |

### Group-Solo

| Endpoint | Returns / does |
|---|---|
| `GET /api/pplns/groups` | Public list of non-dissolved groups |
| `GET /api/pplns/groups/by-address/:address` | Group this address is a member of (if any) |
| `GET /api/pplns/groups/:id` | Group details (members, hashrate, balances) |
| `GET /api/pplns/groups/:id/chart?range=1d\|3d\|7d` | Group hashrate time-series (drop-in compatible with `/info/chart`) |
| `GET /api/pplns/groups/:id/accepted\|/rejected` | Group-wide share aggregates |
| `GET /api/pplns/groups/:id/distribution` | Current round distribution |
| `GET /api/pplns/groups/:id/best-difficulty` | Highest single-share diff in the round |
| `GET /api/pplns/groups/:id/history` | Block-find history for the group |
| `POST /api/pplns/groups` | Create a new group — returns admin token (shown **once**) |
| `POST /api/pplns/groups/:id/invitations` | Admin: send invitation email (requires verified email binding on invitee) |
| `POST /api/pplns/groups/:id/invitations/batch` | Admin: batch invite |
| `GET /api/pplns/groups/:id/invitations` | Admin: list pending invitations (token stripped) |
| `DELETE /api/pplns/groups/:id/invitations/by-address/:address` | Admin: cancel pending invitation |
| `DELETE /api/pplns/groups/:id/members/:address` | Admin: remove member (14-day inactivity gate) |
| `POST /api/pplns/groups/:id/transfer` | Transfer creator role, rotates admin token |
| `DELETE /api/pplns/groups/:id` | Dissolve group |
| `GET /api/pplns/invitations/by-address/:address` | Pending invitations for an address (masked email, no token) |
| `GET /api/pplns/invitations/:token` | Public invitation detail (token = auth) |
| `POST /api/pplns/invitations/:token/accept` | Accept invitation |
| `POST /api/pplns/invitations/:token/decline` | Decline invitation |

### Blockparty

| Endpoint | Returns / does |
|---|---|
| `GET /api/blockparty` | List of non-dissolved parties |
| `GET /api/blockparty/public` | Public discoverable parties |
| `GET /api/blockparty/by-address/:address` | Party this address admins or is a member of |
| `GET /api/blockparty/:id` | Party details (members, splits, state, status badge) |
| `GET /api/blockparty/:id/history` | Block-find history for the party |
| `POST /api/blockparty` | Create — returns admin token (shown **once**) + party id |
| `PATCH /api/blockparty/:id/splits` | Admin: update splits (resets non-admin confirmations) |
| `POST /api/blockparty/:id/members` | Admin: add member + send invitation email |
| `POST /api/blockparty/:id/members/batch` | Admin: batch invite |
| `POST /api/blockparty/:id/members/:address/resend-invitation` | Admin: re-send invitation (lost-token recovery — clears the member's onboarding state so the next accept mints a fresh `BPM-…` token) |
| `DELETE /api/blockparty/:id/members/:address` | Admin: remove member |
| `GET /api/blockparty/:id/invitations` | Admin: list pending invitations |
| `DELETE /api/blockparty/:id/invitations/:token` | Admin: revoke invitation |
| `DELETE /api/blockparty/:id` | Dissolve (gated by 7-day post-share cooldown) |
| `GET /api/blockparty/invitations/:token` | Public invitation detail (token = auth) |
| `POST /api/blockparty/invitations/:token/accept` | Accept — mints a one-time `BPM-…` member token for re-confirm flows |
| `POST /api/blockparty/invitations/:token/decline` | Decline invitation |

### Email binding (miner self-service)

| Endpoint | Purpose |
|---|---|
| `POST /api/email/register` | Register an email for a BTC address — sends verification mail |
| `GET /api/email/verify/:token` | Consume verification token |
| `GET /api/email/by-address/:address` | Check if/which email is bound (masked) |

---

## Notifications

### Telegram bot

Address-based, no login:

- `/start` — welcome + usage
- `/subscribe` / `/subscribe_bestdiff` — block-found + best-diff notifications
- `/bestdiff_reset` — reset stored best-diff
- `/difficulty` / `/next_difficulty` — network diff + next-retarget estimate
- `/stats` — miner stats
- `/poolhashrate` — pool-wide hashrate

Miners can subscribe with **encrypted BTC addresses** (see [blitzpool-message-encryptor](https://github.com/warioishere/blitzpool-message-encryptor-for-TG) for the encryption helper).

### ntfy

Optional mirror of the Telegram bot to ntfy topics. Set:

```
NTFY_SERVER_URL=https://your-ntfy-server
NTFY_ACCESS_TOKEN=<optional>
NTFY_TOPIC_PREFIX=<optional>
NTFY_DIFF_NOTIFICATIONS=true
```

Post bot commands to the ntfy topic of your address and the service replies on the same channel:

```
curl -d /stats  $NTFY_SERVER_URL/<prefix>1ABC...
curl -d "/subscribe 1DEF..." $NTFY_SERVER_URL/<prefix>1ABC...
```

### Push notifications

Web-Push + Android FCM. See [`docs/PUSH_NOTIFICATIONS.md`](docs/PUSH_NOTIFICATIONS.md).

### GeoIP

Pool peers are enriched via [ip-api.com](https://ip-api.com), 10-minute TTL cache, no config required.

---

## Running Blitzpool with Postgres

SQLite stays the default for development and lightweight installs — keep `DB_TYPE` unset (or `sqlite`) and mount `./DB/public-pool.sqlite` into your containers.

For production, **Postgres is recommended** for concurrency + durability. Ready-made Docker Compose stack: `docker-compose-mainnet-pg.yml`.

It provisions a managed `postgres` service, waits for it to become healthy, and persists data under `./full-setup/data/mainnet/public-pool/pg`. Postgres credentials via `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`, `PG_SSL`.

**Important:** production uses migrations, not `synchronize`. Every new entity needs a matching migration file under `src/migrations/`. `DB_RUN_MIGRATIONS=true` runs them on boot; the compose stacks do this automatically.

### Migrating existing SQLite data to Postgres

1. Stop the pool, back up `DB/public-pool.sqlite`
2. Bring up Postgres with `DB_RUN_MIGRATIONS=true` once to bootstrap the schema
3. Dry run:
   ```bash
   PG_HOST=localhost PG_PORT=5432 PG_USER=pool PG_PASSWORD=secret PG_DATABASE=public_pool \
   npm run migrate:sqlite-to-pg -- --dry-run
   ```
4. Live run:
   ```bash
   npm run migrate:sqlite-to-pg -- --batch-size 1000
   ```
   Use `--sqlite <path>` if your SQLite file lives elsewhere.

The SQLite source is never modified, so replays are safe after a reset. Post-migration, point your deployment at Postgres (`DB_TYPE=postgres`, `PG_*`) and start the services.

See [`POSTGRESQL_MIGRATION_SUMMARY.md`](POSTGRESQL_MIGRATION_SUMMARY.md) for deeper details.

---

## Development

| Command | Does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Nest build → `dist/` |
| `npm test` | Jest unit + integration tests (~600 tests) |
| `npm run lint` | ESLint |

Regtest-driven integration tests need a local bitcoind:

```bash
~/bitcoin-29.0/bin/bitcoind -regtest -daemon \
  -rpcuser=test -rpcpassword=test -rpcport=18443 \
  -datadir=/tmp/blitzpool-regtest-datadir -fallbackfee=0.0002
npx jest --no-coverage
```

`postinstall` runs `patch-package` from `patches/`.

---

## UI

The frontend lives in its own repo: **[blitzpool-ui](https://github.com/warioishere/blitzpool-ui/tree/blitzpool-ui-master)**

It talks to the pool's HTTP API (port 3334 by default) and exposes:

- Splash page with pool hashrate + Block-Luck card + mining-mode showcase (4 modes incl. Blockparty)
- Per-miner dashboard (mode-aware: solo / pplns / group-solo / blockparty)
- Payout-group create/manage flow (invitations, member list, round stats)
- Blockparty admin dashboard with built-in Braiins quick-rental widget + member re-confirm flow
- Mining-modes explainer page
- Push-notifications, language toggle EN / DE, dark theme

Runtime feature flag `PPLNS_GROUPS_PUBLISHED` (UI server ENV) gates the PPLNS + Group-Solo cards in a Coming-Soon state until the operator publishes them.

---

## Credits + contact

Fork of [public-pool](https://github.com/benjamin-wilson/public-pool) by Benjamin Wilson, extended by the Blitzpool team at [yourdevice.ch](https://yourdevice.ch).

- 💬 Telegram: <https://t.me/blitzpool_official_switzerland>
- 💬 Matrix: `#blitzpool:matrix.yourdevice.ch`
- 🐙 GitHub: <https://github.com/warioishere/blitzpool>
- 🔔 ntfy (downtime alerts): <https://ntfy.yourdevice.ch/uptime-blitzpool>

Made in Switzerland. 🇨🇭

> *by Bitcoiners, for Bitcoiners who verify instead of trust.*
