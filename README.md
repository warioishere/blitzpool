# ⚡️ BlitzPool – Bitcoin Mining Pool

Welcome to **BlitzPool**, a lightweight and open-source Bitcoin mining pool based on the [public-pool](https://github.com/benjamin-wilson/public-pool) project – extended with powerful new features and real-world integrations.

Current Version: **v1.2.8**

🌐 **Live Pool:** [https://blitzpool.yourdevice.ch/#/](https://blitzpool.yourdevice.ch/#/)

---

## ✨ What's Special About BlitzPool?

BlitzPool extends the original `public-pool` implementation in multiple ways to enhance usability, automation, and miner transparency:

### ✅ Core Features
- Lightweight, performant Node.js mining pool
- Full support for Bitcoin mainnet
- Stratum V1 protocol support
- Optimized for low-latency share submission with Nagle’s algorithm disabled by default.
- Includes further performance improvements like UTF-8 socket encoding, cached network selection, and efficient big number handling.
- Supports Extranonce Subscribe (XNSub) for dynamic extranonce updates
- loads of Telegram Bot Commands to get basic mining infos

### 🚀 Extended Features by BlitzPool

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

BlitzPool enriches peer information using the free [ip-api.com](https://ip-api.com) geolocation service to resolve city and country details. No configuration is required.

### ⏱️ Stratum rate limiter
BlitzPool tracks how often a peer disconnects within a short window and temporarily blocks IPs that exceed a threshold.

Configure via:

```
STRATUM_RATE_WINDOW_MS=60000   # time window for counting disconnects (default 60s)
STRATUM_RATE_THRESHOLD=5       # disconnects within the window to trigger a block
STRATUM_RATE_BLOCK_MS=1800000  # how long to block the IP (default 30m)
```

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

## API

- `GET /api/info/chart?range=1d|1m` – Returns pool hashrate statistics.
- `GET /api/info/shares` – Provides pool-wide accepted and rejected share totals.
- `GET /api/info/rejected?range=1d|3d|7d` – Lists rejected share reasons pool-wide (difficulty weighted).
- `GET /api/info/accepted?range=1d|3d|7d` – Lists accepted share counts pool-wide per 10-minute slot.
- `GET /api/info/block-template` – Returns the current block template used for mining.
- `GET /api/info/version` – Returns the BlitzPool version.
- `GET /api/client/<btc_address>/rejected?range=1d|3d|7d` – Returns per 10-minute slot each rejected reason with its share count and diff-1 weighted total (`diffMinusOne`).
- `GET /api/client/<btc_address>/accepted?range=1d|3d|7d` – Shows diff-1 weighted accepted share counts for a specific address per 10-minute slot.

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




