# ⚡️ BlitzPool – Bitcoin Mining Pool

Welcome to **BlitzPool**, a lightweight and open-source Bitcoin mining pool based on the [public-pool](https://github.com/benjamin-wilson/public-pool) project – extended with powerful new features and real-world integrations.

Current Version: **v1.2**

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
- /english                  Switch bot replies to English
- /deutsch                  Bot Antworten auf Deutsch
- /subscribe	        Subscribe to receive block found notifications for your mining address
- /subscribe_bestdiff	Toggle Best-Diff notifications on or off (default: on)
- /difficulty	        Shows the current Bitcoin network difficulty
- /next_difficulty	    Estimates the next network difficulty adjustment
- /stats                    Displays detailed mining stats for your Bitcoin address including share and reject totals
- /poolhashrate          Shows the current pool hashrate

- ➡️ Subscriptions are address-based and persistent – no account or login needed.
- ➡️ For Stats, worker addresse need to be given on every command. 
- ➡️ btc worker addresse can be send encrypted with an own tool, pls see next steps:

#### 🔐 Encrypted Address Tracking
- Subscribe with **encrypted BTC addresses** for enhanced privacy
- Addresses are decrypted internally and securely matched to your mining activity

Use our Encryption tool for btc worker addresses here:

https://github.com/warioishere/blitzpool-message-encryptor-for-TG

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
- New `/api/client/<btc_address>/rejected` shows rejected reasons for a specific address (supports `range=1d|3d|7d`)
- New `/api/client/<btc_address>/stats` returns combined statistics for an address and its workers
- Old jobs are cleaned after 90 seconds by default (`JOB_RETENTION_MS` can adjust this)
- Desired share rate per worker can be tuned with `TARGET_SHARES_PER_MINUTE` (default `6`)
- How often miners are checked for new difficulty can be set via `DIFFICULTY_CHECK_INTERVAL_MS` (default `60000` ms)

## API

- `GET /api/info/chart?range=1d|1m` – Returns pool hashrate statistics.
- `GET /api/info/shares` – Provides pool-wide accepted and rejected share totals.
- `GET /api/info/rejected?range=1d|3d|7d` – Lists rejected share reasons pool-wide (difficulty weighted).
- `GET /api/info/version` – Returns the BlitzPool version.
- `GET /api/client/<btc_address>/rejected?range=1d|3d|7d` – Shows rejected reasons for a specific address (counts per share).
- `GET /api/client/<btc_address>/stats` – Shows combined totals and per-worker statistics. Rejected counts are difficulty weighted.

Example response from `/api/client/<btc_address>/stats`:

```json
{
  "hashrate1m": "596T",
  "hashrate5m": "615T",
  "hashrate1hr": "704T",
  "hashrate1d": "658T",
  "hashrate7d": "484T",
  "workers": 53,
  "shares": 703029762124,
  "rejected": 42,
  "bestever": 183996631107,
  "worker": [
    {
      "workername": "example.worker1",
      "hashrate1m": "1.74T",
      "hashrate5m": "1.49T",
      "hashrate1hr": "1.37T",
      "hashrate1d": "1.43T",
      "hashrate7d": "1.36T",
      "lastshare": 1234,
      "shares": 1404625542,
      "rejected": 1,
      "bestshare": 794572222.3472384,
      "bestshareever": 794572222
    }
  ]
}
```

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




