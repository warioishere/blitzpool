# ⚡️ BlitzPool – Bitcoin Mining Pool

Welcome to **BlitzPool**, a lightweight and open-source Bitcoin mining pool based on the [public-pool](https://github.com/benjamin-wilson/public-pool) project – extended with powerful new features and real-world integrations.

🌐 **Live Pool:** [https://blitzpool.yourdevice.ch/#/](https://blitzpool.yourdevice.ch/#/)

---

## ✨ What's Special About BlitzPool?

BlitzPool extends the original `public-pool` implementation in multiple ways to enhance usability, automation, and miner transparency:

### ✅ Core Features
- Lightweight, performant Node.js mining pool
- Full support for Bitcoin mainnet, testnet, and regtest
- Stratum V1 protocol support

### 🚀 Extended Features by BlitzPool

### 🤖 Telegram Bot Commands

The BlitzPool Telegram bot offers real-time interaction and notification options via the following commands:
Command	Description
- /start	Displays a welcome message and usage instructions
- /subscribe	Subscribe to receive block found notifications for your mining address
- /subscribe_bestdiff	Toggle Best-Diff notifications on or off (default: on)
- /difficulty	Shows the current Bitcoin network difficulty
- /next_difficulty	Estimates the next network difficulty adjustment
- /stats	Displays detailed mining stats for your subscribed Bitcoin address

➡️ Subscriptions are address-based and persistent – no account or login needed.
➡️ For Stats, worker addresse need to be given on every command. 
➡️ btc worker addresse can be send encrypted with an own tool, pls see next steps:

#### 🔐 Encrypted Address Tracking
- Subscribe with **encrypted BTC addresses** for enhanced privacy
- Addresses are decrypted internally and securely matched to your mining activity

Use our Encryption tool for btc worker addresses here:

https://github.com/warioishere/blitzpool-message-encryptor-for-TG

#### 🛠️ Extra Services
- Integrated `blockTemplateInterval` configuration
- Hashrate corrections and updated statistics endpoints
- Telegram bot subscriptions managed via a custom ORM

---
💬 Contact

For updates, support, and to join the community, reach out via:

    Matrix: @blitzpool:yourdevice.ch

    Telegram: https://t.me/blitzpool_official_switzerland

🙏 Credits

This project is a fork of the excellent public-pool by benjamin-wilson, extended and maintained by the BlitzPool team at yourdevice.ch.




