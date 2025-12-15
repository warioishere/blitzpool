# UnifiedPush Server Setup Guide

This guide explains how to set up the UnifiedPush notification server on your stratum server (port 3334).

---

## Overview

The UnifiedPush server component monitors best difficulty for mining addresses and sends push notifications when difficulty increases. It consists of:

- **3 REST API endpoints** for managing subscriptions
- **Background worker** that checks difficulty every 60 seconds
- **Database tables** for storing subscriptions and tracking difficulty
- **Optional VAPID support** for future ntfy compatibility

---

## Prerequisites

- Node.js server with Express already running (your stratum server on port 3334)
- SQLite database with `better-sqlite3`
- Access to the same database that stores client mining data (`best_difficulty` column)

---

## Step 1: Install Dependencies

```bash
cd /path/to/your/stratum/server
npm install web-push --save
```

**Package installed:**
- `web-push@^3.6.7` - For optional VAPID support

---

## Step 2: Create Database Tables

Add these tables to your SQLite database:

```sql
-- Table to store push notification subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    platform TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastNotificationAt INTEGER,
    UNIQUE(address, endpoint)
);

-- Table to track best difficulty per address
CREATE TABLE IF NOT EXISTS best_difficulty_tracker (
    address TEXT PRIMARY KEY,
    bestDifficulty REAL NOT NULL,
    lastCheckedAt INTEGER NOT NULL
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_address ON push_subscriptions(address);
```

**How to run:**
- If using a migration system: Create a new migration file
- If using direct SQL: Run via SQLite CLI or database management tool
- If using `database.ts`: Add to your initialization function

---

## Step 3: Create Repository Layer

Create `repositories/push.repository.ts`:

```typescript
import Database from 'better-sqlite3';

export interface PushSubscription {
    id: number;
    address: string;
    endpoint: string;
    platform: string;
    createdAt: number;
    lastNotificationAt: number | null;
}

export interface BestDifficultyTracker {
    address: string;
    bestDifficulty: number;
    lastCheckedAt: number;
}

export class PushRepository {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
    }

    /**
     * Create a new push subscription
     */
    create(address: string, endpoint: string, platform: string): PushSubscription {
        const stmt = this.db.prepare(`
            INSERT INTO push_subscriptions (address, endpoint, platform, createdAt)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(address, endpoint) DO UPDATE SET
                platform = excluded.platform,
                createdAt = excluded.createdAt
            RETURNING *
        `);

        return stmt.get(address, endpoint, platform, Date.now()) as PushSubscription;
    }

    /**
     * Delete subscription by address and endpoint
     */
    delete(address: string, endpoint: string): void {
        const stmt = this.db.prepare(
            'DELETE FROM push_subscriptions WHERE address = ? AND endpoint = ?'
        );
        stmt.run(address, endpoint);
    }

    /**
     * Delete all subscriptions for an address
     */
    deleteByAddress(address: string): void {
        const stmt = this.db.prepare('DELETE FROM push_subscriptions WHERE address = ?');
        stmt.run(address);
    }

    /**
     * Get all subscriptions for an address
     */
    getByAddress(address: string): PushSubscription[] {
        const stmt = this.db.prepare('SELECT * FROM push_subscriptions WHERE address = ?');
        return stmt.all(address) as PushSubscription[];
    }

    /**
     * Get all unique addresses with subscriptions
     */
    getAddressesWithSubscriptions(): string[] {
        const stmt = this.db.prepare('SELECT DISTINCT address FROM push_subscriptions');
        const rows = stmt.all() as Array<{ address: string }>;
        return rows.map(row => row.address);
    }

    /**
     * Update last notification timestamp
     */
    updateLastNotification(id: number): void {
        const stmt = this.db.prepare(
            'UPDATE push_subscriptions SET lastNotificationAt = ? WHERE id = ?'
        );
        stmt.run(Date.now(), id);
    }

    /**
     * Get best difficulty tracker for address
     */
    getBestDifficulty(address: string): BestDifficultyTracker | null {
        const stmt = this.db.prepare(
            'SELECT * FROM best_difficulty_tracker WHERE address = ?'
        );
        return stmt.get(address) as BestDifficultyTracker | null;
    }

    /**
     * Update or create best difficulty tracker
     */
    updateBestDifficulty(address: string, difficulty: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO best_difficulty_tracker (address, bestDifficulty, lastCheckedAt)
            VALUES (?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET
                bestDifficulty = excluded.bestDifficulty,
                lastCheckedAt = excluded.lastCheckedAt
        `);
        stmt.run(address, difficulty, Date.now());
    }
}
```

---

## Step 4: Create Push Notification Service

Create `services/push-notification.service.ts`:

```typescript
import { PushRepository } from '../repositories/push.repository';
import https from 'https';
import http from 'http';
import * as webpush from 'web-push';

// Initialize VAPID if keys are configured
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:noreply@yourserver.com';

const useVAPID = vapidPublicKey && vapidPrivateKey;

if (useVAPID) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey!, vapidPrivateKey!);
    console.log('VAPID enabled for push notifications');
} else {
    console.log('VAPID disabled - using plain POST (ntfy compatible)');
}

const CHECK_INTERVAL_MS = 60000; // 60 seconds
const MIN_NOTIFICATION_INTERVAL_MS = 300000; // 5 minutes
let workerInterval: NodeJS.Timeout | null = null;

/**
 * Format difficulty number with suffix (T, G, M, K)
 */
function formatDifficulty(num: number): string {
    if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'G';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toString();
}

/**
 * Send push notification using plain POST (ntfy-compatible)
 */
async function sendPlainPost(endpoint: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const url = new URL(endpoint);
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'Content-Length': Buffer.byteLength(message)
                }
            };

            const req = client.request(options, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(true);
                } else {
                    console.error(`Push failed: HTTP ${res.statusCode}`);
                    resolve(false);
                }
            });

            req.on('error', (error) => {
                console.error('Push error:', error.message);
                resolve(false);
            });

            req.write(message);
            req.end();
        } catch (error: any) {
            console.error('Push error:', error.message);
            resolve(false);
        }
    });
}

/**
 * Send push notification to UnifiedPush endpoint
 * Supports both VAPID authentication (optional) and plain POST (fallback)
 */
async function sendPushNotification(
    endpoint: string,
    title: string,
    body: string,
    difficulty: string
): Promise<boolean> {
    // Message format: "title|body|difficulty"
    const message = `${title}|${body}|${difficulty}`;

    try {
        if (useVAPID) {
            // Use VAPID authentication (for future ntfy support)
            await webpush.sendNotification(
                { endpoint },
                message,
                {
                    TTL: 3600,
                    urgency: 'high'
                }
            );
            console.log('Push sent (VAPID):', title);
            return true;
        } else {
            // Fallback to plain POST (current ntfy support)
            const success = await sendPlainPost(endpoint, message);
            if (success) {
                console.log('Push sent (plain):', title);
            }
            return success;
        }
    } catch (error: any) {
        console.error('Push send error:', error.message);
        return false;
    }
}

/**
 * Get client info from your existing API
 * ADJUST THIS to match your actual client data structure
 */
async function getClientInfo(address: string): Promise<any> {
    return new Promise((resolve) => {
        try {
            // IMPORTANT: Replace with your actual client data fetch logic
            // This is just an example - adjust to your database schema

            // Option 1: If you have a function to get client data
            // const clientData = yourGetClientFunction(address);
            // resolve(clientData);

            // Option 2: If you need to query the database
            // const stmt = db.prepare('SELECT * FROM clients WHERE address = ?');
            // const client = stmt.get(address);
            // resolve(client);

            // Placeholder - REPLACE THIS
            resolve(null);
        } catch (error: any) {
            console.error('Error getting client info:', error.message);
            resolve(null);
        }
    });
}

/**
 * Check best difficulty for all subscribed addresses
 * Sends push notifications if difficulty has increased
 */
async function checkBestDifficulty(pushRepository: PushRepository): Promise<void> {
    try {
        const addresses = pushRepository.getAddressesWithSubscriptions();

        if (addresses.length === 0) {
            return;
        }

        console.log(`Checking best difficulty for ${addresses.length} addresses`);

        for (const address of addresses) {
            try {
                // Get current client info
                const clientInfo = await getClientInfo(address);
                if (!clientInfo || !clientInfo.bestDifficulty) {
                    continue;
                }

                const currentDifficulty = clientInfo.bestDifficulty;

                // Get stored best difficulty
                const tracker = pushRepository.getBestDifficulty(address);

                // If no tracker exists, initialize it
                if (!tracker) {
                    pushRepository.updateBestDifficulty(address, currentDifficulty);
                    continue;
                }

                // Check if difficulty has increased
                if (currentDifficulty > tracker.bestDifficulty) {
                    console.log(`Difficulty increased for ${address}: ${tracker.bestDifficulty} -> ${currentDifficulty}`);

                    // Get subscriptions for this address
                    const subscriptions = pushRepository.getByAddress(address);

                    // Send push notification to all endpoints
                    const title = 'New Best Difficulty!';
                    const body = `Your best difficulty increased to ${formatDifficulty(currentDifficulty)}`;
                    const difficultyStr = formatDifficulty(currentDifficulty);

                    for (const subscription of subscriptions) {
                        // Check rate limiting
                        if (subscription.lastNotificationAt) {
                            const timeSinceLastNotification = Date.now() - subscription.lastNotificationAt;
                            if (timeSinceLastNotification < MIN_NOTIFICATION_INTERVAL_MS) {
                                console.log(`Rate limited: ${address}`);
                                continue;
                            }
                        }

                        // Send push notification
                        const success = await sendPushNotification(
                            subscription.endpoint,
                            title,
                            body,
                            difficultyStr
                        );

                        if (success) {
                            pushRepository.updateLastNotification(subscription.id);
                        }
                    }

                    // Update tracker with new best difficulty
                    pushRepository.updateBestDifficulty(address, currentDifficulty);
                }
            } catch (error: any) {
                console.error(`Error checking address ${address}:`, error.message);
            }
        }
    } catch (error: any) {
        console.error('Error in checkBestDifficulty:', error.message);
    }
}

/**
 * Start the push notification worker
 */
export function startPushNotificationWorker(pushRepository: PushRepository): void {
    if (workerInterval) {
        console.warn('Push worker already running');
        return;
    }

    console.log(`Starting push notification worker (interval: ${CHECK_INTERVAL_MS}ms)`);

    // Run immediately on start
    checkBestDifficulty(pushRepository);

    // Then run on interval
    workerInterval = setInterval(() => {
        checkBestDifficulty(pushRepository);
    }, CHECK_INTERVAL_MS);
}

/**
 * Stop the push notification worker
 */
export function stopPushNotificationWorker(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        console.log('Push notification worker stopped');
    }
}
```

---

## Step 5: Create API Controller

Create `controllers/push.controller.ts`:

```typescript
import { Request, Response } from 'express';
import { PushRepository } from '../repositories/push.repository';

export class PushController {
    constructor(private pushRepository: PushRepository) {}

    /**
     * POST /push/register
     * Register a new push subscription
     */
    register = (req: Request, res: Response): void => {
        try {
            const { address, endpoint, platform } = req.body;

            // Validate input
            if (!address || !endpoint) {
                res.status(400).json({ error: 'Missing required fields: address, endpoint' });
                return;
            }

            // Create subscription
            const subscription = this.pushRepository.create(
                address,
                endpoint,
                platform || 'unknown'
            );

            console.log(`Push subscription registered: ${address} -> ${endpoint}`);

            res.status(201).json({
                success: true,
                subscription: {
                    id: subscription.id,
                    address: subscription.address,
                    platform: subscription.platform,
                    createdAt: subscription.createdAt
                }
            });
        } catch (error: any) {
            console.error('Error registering push subscription:', error);
            res.status(500).json({ error: 'Failed to register push subscription' });
        }
    };

    /**
     * POST /push/unregister
     * Unregister from push notifications
     */
    unregister = (req: Request, res: Response): void => {
        try {
            const { address, endpoint } = req.body;

            // Validate input
            if (!address) {
                res.status(400).json({ error: 'Missing required field: address' });
                return;
            }

            // Delete subscription(s)
            if (endpoint) {
                this.pushRepository.delete(address, endpoint);
            } else {
                this.pushRepository.deleteByAddress(address);
            }

            console.log(`Push subscription unregistered: ${address}`);

            res.json({ success: true });
        } catch (error: any) {
            console.error('Error unregistering push subscription:', error);
            res.status(500).json({ error: 'Failed to unregister push subscription' });
        }
    };

    /**
     * GET /push/status/:address
     * Get subscription status for an address
     */
    getStatus = (req: Request, res: Response): void => {
        try {
            const { address } = req.params;

            const subscriptions = this.pushRepository.getByAddress(address);
            const tracker = this.pushRepository.getBestDifficulty(address);

            res.json({
                address,
                subscriptionCount: subscriptions.length,
                subscriptions: subscriptions.map(s => ({
                    id: s.id,
                    platform: s.platform,
                    createdAt: s.createdAt,
                    lastNotificationAt: s.lastNotificationAt
                })),
                tracker: tracker ? {
                    bestDifficulty: tracker.bestDifficulty,
                    lastCheckedAt: tracker.lastCheckedAt
                } : null
            });
        } catch (error: any) {
            console.error('Error getting push status:', error);
            res.status(500).json({ error: 'Failed to get push status' });
        }
    };
}
```

---

## Step 6: Integrate into Express App

Update your main server file (e.g., `app.ts` or `server.ts`):

```typescript
import express from 'express';
import Database from 'better-sqlite3';
import { PushRepository } from './repositories/push.repository';
import { PushController } from './controllers/push.controller';
import { startPushNotificationWorker } from './services/push-notification.service';

const app = express();
const db = new Database('your-database.db'); // Your existing database

// Middleware
app.use(express.json());

// Initialize Push Repository
const pushRepository = new PushRepository(db);
const pushController = new PushController(pushRepository);

// Push Notification Routes
app.post('/push/register', pushController.register);
app.post('/push/unregister', pushController.unregister);
app.get('/push/status/:address', pushController.getStatus);

// Start background worker
startPushNotificationWorker(pushRepository);

// ... rest of your server setup

const PORT = process.env.PORT || 3334;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
```

---

## Step 7: Configure Environment Variables

Create `.env` file in your server root:

```bash
# Optional VAPID Configuration for UnifiedPush
# Leave commented out to use plain POST (ntfy compatible)
# Uncomment when ntfy adds VAPID support

#VAPID_PUBLIC_KEY=BD_HH99NfIBL28rZeP9zujOkB5lZxF188gfk1XRVtF-rgPR6clF81uJwQnAT1geL6O2NdBzanQeY1_ojmHfCzfo
#VAPID_PRIVATE_KEY=PnkVfs1p_yqdkrnTY7K-oLuFFLUkfXpATophp8ZLu2A
#VAPID_SUBJECT=mailto:admin@yourserver.com
```

**To generate VAPID keys (when needed):**
```bash
npx web-push generate-vapid-keys
```

---

## Step 8: Update .gitignore

Ensure `.env` is gitignored:

```bash
echo ".env" >> .gitignore
```

---

## Critical Configuration Points

### 1. Client Data Integration

In `push-notification.service.ts`, you **MUST** update the `getClientInfo()` function to match your actual data structure:

```typescript
async function getClientInfo(address: string): Promise<any> {
    // REPLACE THIS with your actual client data fetch logic
    // Example: Query your database for client stats
    const stmt = db.prepare('SELECT * FROM clients WHERE address = ?');
    const client = stmt.get(address);

    // Make sure it returns an object with bestDifficulty property
    return client;
}
```

### 2. Database Connection

Make sure the `PushRepository` receives your existing database instance:

```typescript
const db = new Database('path/to/your/stratum.db');
const pushRepository = new PushRepository(db);
```

### 3. CORS (if needed)

If your UI is on a different domain, add CORS:

```typescript
import cors from 'cors';

app.use(cors({
    origin: 'https://blitzpool.yourdevice.ch',
    credentials: true
}));
```

---

## Testing

### 1. Test API Endpoints

```bash
# Register subscription
curl -X POST http://localhost:3334/push/register \
  -H "Content-Type: application/json" \
  -d '{"address":"your_btc_address","endpoint":"https://ntfy.yourdevice.ch/test","platform":"android"}'

# Check status
curl http://localhost:3334/push/status/your_btc_address

# Unregister
curl -X POST http://localhost:3334/push/unregister \
  -H "Content-Type: application/json" \
  -d '{"address":"your_btc_address"}'
```

### 2. Test Manual Notification

```bash
curl -X POST https://ntfy.yourdevice.ch/your_topic \
  -H "Content-Type: text/plain" \
  -d "Test Title|Test body|1.5T"
```

---

## File Structure

Your server directory should look like:

```
your-stratum-server/
├── controllers/
│   └── push.controller.ts
├── repositories/
│   └── push.repository.ts
├── services/
│   └── push-notification.service.ts
├── app.ts (or server.ts)
├── database.db
├── .env
├── .gitignore
└── package.json
```

---

## Monitoring

Add logging to track the worker:

```typescript
// In push-notification.service.ts
console.log(`Checking best difficulty for ${addresses.length} addresses`);
console.log(`Difficulty increased for ${address}: ${old} -> ${new}`);
console.log(`Push sent successfully to ${endpoint}`);
```

Check logs to verify:
- Worker is running every 60 seconds
- Subscriptions are being checked
- Notifications are sent when difficulty increases

---

## Troubleshooting

### Worker Not Running
- Check server logs for "Starting push notification worker"
- Verify `startPushNotificationWorker()` is called in app initialization

### No Notifications Sent
- Check that `getClientInfo()` returns valid data with `bestDifficulty` property
- Verify subscriptions exist in database: `SELECT * FROM push_subscriptions;`
- Check rate limiting (5 min between notifications per address)

### Database Errors
- Ensure tables are created before server starts
- Check database file permissions
- Verify `better-sqlite3` is installed

---

## Next Steps

After setting this up on your stratum server:
1. Test all 3 endpoints (`/push/register`, `/push/unregister`, `/push/status/:address`)
2. Verify background worker starts and runs
3. Test end-to-end notification flow
4. Monitor logs for any errors
5. Once confirmed working, we'll remove these files from the UI repo

---

## Security Notes

- ✅ `.env` is gitignored (VAPID keys are secret)
- ✅ Input validation on all endpoints
- ✅ Rate limiting prevents notification spam
- ✅ No sensitive data in notifications (only difficulty numbers)
- ⚠️ Consider adding authentication to endpoints in production
- ⚠️ Consider HTTPS for all push endpoints

---

## Support

If you encounter issues:
1. Check server logs for errors
2. Verify database tables exist
3. Test endpoints individually with curl
4. Ensure `getClientInfo()` returns correct data structure
5. Check that addresses in subscriptions match your client database

---

**End of Setup Guide**
