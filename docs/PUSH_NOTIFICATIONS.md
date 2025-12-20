# Push Notifications Guide

This guide explains how to register for and manage push notifications on BlitzPool. You can receive notifications about:
- **Best Difficulty**: When your mining difficulty increases
- **Device Status**: When your mining device goes online or offline
- **Block Hits**: When your address finds a block

We support two notification methods:
1. **Unified Push (UP)** - Privacy-focused, decentralized
2. **Firebase Cloud Messaging (FCM)** - For native mobile apps

---

## Quick Start

### Option 1: Unified Push (Recommended for Privacy)

**Step 1: Get an endpoint from a distributor**

First, you need to set up a Unified Push distributor and get an endpoint. The distributor app or service will give you an endpoint URL to use.

Examples:
- **ntfy.sh**: Just open https://ntfy.sh/my-unique-topic-name in your ntfy app (no signup needed)
- **Pushbullet**: Get your endpoint from your Pushbullet account settings
- **Self-hosted**: Run your own distributor and get endpoints from it

**Step 2: Register the endpoint with BlitzPool**

```bash
# Tell BlitzPool where to send your notifications
curl -X POST http://blitzpool.example.com/api/push/register \
  -H "Content-Type: application/json" \
  -d '{
    "address": "bc1q1234567890abcdef1234567890abcdef",
    "endpoint": "https://ntfy.sh/my-mining-alerts",
    "platform": "ntfy"
  }'
```

The endpoint URL comes from your distributor app/service.

**Step 3: Enable notification types**

```bash
curl -X POST http://blitzpool.example.com/api/push/configure \
  -H "Content-Type: application/json" \
  -d '{
    "address": "bc1q1234567890abcdef1234567890abcdef",
    "endpoint": "https://ntfy.sh/my-mining-alerts",
    "bestDiffNotifications": true,
    "deviceNotifications": true,
    "blockNotifications": true
  }'
```

**Step 4: Check status**

```bash
curl http://blitzpool.example.com/api/push/status/bc1q1234567890abcdef1234567890abcdef
```

**Flow Diagram:**
```
Your Device                BlitzPool                 Distributor              Your App
─────────────              ─────────────              ───────────              ────────
   (ntfy app)              (pool server)              (ntfy.sh)               (receives)
      │                          │                         │                      │
      │ 1. Subscribe to topic    │                         │                      │
      ├─────────────────────────>│                         │                      │
      │                          │                         │                      │
      │ 2. Tell BlitzPool        │                         │                      │
      │    endpoint URL          │                         │                      │
      │ (https://ntfy.sh/topic)  │                         │                      │
      │                          │ 3. Sends notification   │                      │
      │                          ├────────────────────────>│                      │
      │                          │                         │ 4. Forwards to app   │
      │                          │                         ├────────────────────>│
      │                          │                         │                      │
      │<─────────────────────────────────────────────────────────────────────────┤
      │              You receive notification on your device                      │
```

### Option 2: Firebase Cloud Messaging (FCM - Native Apps)

```bash
# 1. Register your FCM device token (from your mobile app)
curl -X POST http://blitzpool.example.com/api/push/fcm/register \
  -H "Content-Type: application/json" \
  -d '{
    "address": "bc1q1234567890abcdef1234567890abcdef",
    "token": "dGhpcyBpcyBhIGZha2UgZkNNIHRva2VuIGZvciBkZW1vIHB1cnBvc2VzIG9ubHk",
    "platform": "android"
  }'

# 2. Enable notification types
curl -X POST http://blitzpool.example.com/api/push/configure \
  -H "Content-Type: application/json" \
  -d '{
    "address": "bc1q1234567890abcdef1234567890abcdef",
    "endpoint": "dGhpcyBpcyBhIGZha2UgZkNNIHRva2VuIGZvciBkZW1vIHB1cnBvc2VzIG9ubHk",
    "bestDiffNotifications": true,
    "deviceNotifications": true,
    "blockNotifications": true
  }'

# 3. Check status
curl http://blitzpool.example.com/api/push/status/bc1q1234567890abcdef1234567890abcdef
```

---

## Detailed Documentation

### 1. Unified Push Registration

#### What is Unified Push?

Unified Push is an open standard for decentralized push notifications. It allows you to use any notification distributor you choose instead of relying on a single company.

**How it works:**
1. You choose a **distributor** (a service that receives and forwards notifications)
2. You subscribe to a topic with that distributor (using their app)
3. The distributor gives you an **endpoint URL**
4. You register that endpoint with BlitzPool
5. BlitzPool sends notifications to the distributor
6. The distributor forwards notifications to your app

**Popular Unified Push distributors:**

- **ntfy.sh** - Simplest option, no signup required, free (https://ntfy.sh)
  - Just open ntfy app, subscribe to a topic name
  - Endpoint: `https://ntfy.sh/your-topic-name`

- **Pushbullet** - Feature-rich service with accounts (https://www.pushbullet.com)
  - Requires signup and account
  - Get endpoint from account settings

- **Self-hosted** - Run your own distributor (see https://unifiedpush.org/)
  - More complex setup
  - Full control over notifications

#### Register Endpoint

**Endpoint:**
```
POST /api/push/register
```

**Required Fields:**
- `address` (string, 62 chars) - Your Bitcoin address
- `endpoint` (string) - Your Unified Push endpoint URL
- `platform` (string, optional, default: "unknown") - Platform name for identification

**Request Example:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "endpoint": "https://ntfy.sh/my-blitzpool-alerts",
  "platform": "ntfy"
}
```

**Response Example:**
```json
{
  "success": true,
  "subscription": {
    "id": 42,
    "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "platform": "ntfy",
    "createdAt": "2024-12-18T10:30:00Z"
  }
}
```

**How to Get a Unified Push Endpoint:**

The endpoint is **provided by the Unified Push distributor** you choose to use. You don't create it yourself - the distributor gives it to you.

1. **Using ntfy.sh (simplest):**
   - No signup required
   - Open the ntfy app or web interface
   - Subscribe to any unique topic name (e.g., "my-mining-alerts")
   - The endpoint will be: `https://ntfy.sh/my-unique-topic-name`
   - This is what you register with BlitzPool

2. **Using Pushbullet:**
   - Sign up at https://www.pushbullet.com/
   - Go to your account settings
   - Find your Pushbullet endpoint URL for push notifications
   - Use that endpoint URL with BlitzPool

3. **Self-hosted distributor:**
   - Run your own Unified Push distributor (see https://unifiedpush.org/)
   - Configure your app to use your distributor
   - Get the endpoint URL from your distributor
   - Register that URL with BlitzPool

**Key Points:**
- You get the endpoint FROM the distributor, not the other way around
- The distributor app (ntfy, Pushbullet, etc.) receives notifications FROM BlitzPool
- Your client app receives notifications FROM the distributor app
- The endpoint is a URL that BlitzPool uses to send notifications

---

### 2. Firebase Cloud Messaging (FCM) Registration

#### What is FCM?

Firebase Cloud Messaging is Google's service for sending notifications to native mobile apps (Android & iOS). Use this if you're building a mobile app for BlitzPool.

#### Register Token Endpoint

**Endpoint:**
```
POST /api/push/fcm/register
```

**Required Fields:**
- `address` (string, 62 chars) - Your Bitcoin address
- `token` (string) - Your FCM device token from your mobile app
- `platform` (string, optional, default: "fcm") - "android", "ios", "web"

**Request Example:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "token": "eRx9R8tUVzBBNIH9_8HYKjd7fKQRx4XO3IvlB6HK2Ko:APA91bHLl_8-0j8I3xEqR4j9xVl_yD7Wjb4K5Z6Y1Xl0PqN",
  "platform": "android"
}
```

**Response Example:**
```json
{
  "success": true,
  "subscriptionType": "fcm",
  "subscription": {
    "id": 43,
    "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "platform": "android",
    "createdAt": "2024-12-18T10:35:00Z"
  }
}
```

**Token Format:**
- Valid FCM tokens are 152-163 characters
- Contains alphanumeric characters, colons, underscores, hyphens
- Invalid tokens will be rejected with 400 error

**How to Get an FCM Token (Mobile App):**

**Android (using Firebase Cloud Messaging library):**
```javascript
// In your React Native or Android app
import messaging from '@react-native-firebase/messaging';

const token = await messaging().getToken();
console.log('FCM Token:', token);
```

**iOS (using Firebase Cloud Messaging library):**
```swift
import FirebaseMessaging

Messaging.messaging().token { token, error in
  if let error = error {
    print("Error fetching FCM token: \(error)")
  } else if let token = token {
    print("FCM token: \(token)")
  }
}
```

**Web (using Firebase JavaScript SDK):**
```javascript
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken } from 'firebase/messaging';

const messaging = getMessaging();
getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' }).then((currentToken) => {
  if (currentToken) {
    console.log('FCM Token:', currentToken);
  }
});
```

**Notes:**
- Tokens can expire and change - refresh periodically (monthly recommended)
- Always request user permission before sending notifications
- Keep tokens secure, don't expose in logs

---

### 3. Unregister Endpoints

#### Remove Unified Push Subscription

**Endpoint:**
```
POST /api/push/unregister
```

**Remove Specific Endpoint:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "endpoint": "https://ntfy.sh/my-blitzpool-alerts"
}
```

**Remove All Unified Push Subscriptions for Address:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
}
```

#### Remove FCM Token

**Endpoint:**
```
POST /api/push/fcm/unregister
```

**Remove Specific Token:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "token": "eRx9R8tUVzBBNIH9_8HYKjd7fKQRx4XO3IvlB6HK2Ko:APA91bHLl_8-0j8I3xEqR4j9xVl_yD7Wjb4K5Z6Y1Xl0PqN"
}
```

**Remove All FCM Tokens for Address:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
}
```

**Response:**
```json
{
  "success": true
}
```

---

### 4. Configure Notification Preferences

#### Update Notification Types

**Endpoint:**
```
POST /api/push/configure
```

**Request:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "endpoint": "https://ntfy.sh/my-blitzpool-alerts",
  "bestDiffNotifications": true,
  "deviceNotifications": true,
  "blockNotifications": false
}
```

**Parameters:**
- `address` (required) - Bitcoin address
- `endpoint` (required) - Your Unified Push endpoint or FCM token
- `bestDiffNotifications` (optional, boolean) - Enable best difficulty notifications
- `deviceNotifications` (optional, boolean) - Enable device status notifications
- `blockNotifications` (optional, boolean) - Enable block found notifications

**Notes:**
- Only include the parameters you want to update
- If a parameter is omitted, it will not be changed
- All defaults are `false` (you must explicitly enable)

**Response:**
```json
{
  "success": true
}
```

---

### 5. Check Subscription Status

#### Get Status for Address

**Endpoint:**
```
GET /api/push/status/:address
```

**Example Request:**
```
GET /api/push/status/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
```

**Response Example:**
```json
{
  "address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "subscriptionCount": 2,
  "subscriptions": [
    {
      "id": 42,
      "platform": "ntfy",
      "endpoint": "https://ntfy.sh/my-blitzpool-alerts",
      "subscriptionType": "unified_push",
      "createdAt": "2024-12-18T10:30:00Z",
      "lastNotificationAt": 1734567890000,
      "bestDiffNotificationsEnabled": true,
      "deviceNotificationsEnabled": true,
      "blockNotificationsEnabled": false
    },
    {
      "id": 43,
      "platform": "android",
      "endpoint": "eRx9R8tUVzBBNIH9_8HYKjd7fKQRx4XO...",
      "subscriptionType": "fcm",
      "createdAt": "2024-12-18T10:35:00Z",
      "lastNotificationAt": 1734567920000,
      "bestDiffNotificationsEnabled": true,
      "deviceNotificationsEnabled": true,
      "blockNotificationsEnabled": true
    }
  ],
  "tracker": {
    "bestDifficulty": 158500000000000,
    "lastCheckedAt": 1734567890000
  }
}
```

**Fields Explained:**
- `subscriptionCount` - Total number of subscriptions (UP + FCM)
- `subscriptions` - Array of all active subscriptions
  - `subscriptionType` - Either "unified_push" or "fcm"
  - `lastNotificationAt` - Unix timestamp of last notification sent
  - `lastCheckedAt` - When best difficulty was last checked
- `tracker` - Best difficulty tracking info (updated every 60 seconds)

---

## Notification Types & Formats

### 1. Best Difficulty Notification

**When:** Every 60 seconds, if your personal best difficulty increased

**Unified Push Format:**
```
New Best Difficulty!|Your best difficulty increased to 158.50T|158.50T
```

**FCM Format:**
```json
{
  "notification": {
    "title": "New Best Difficulty!",
    "body": "Your best difficulty increased to 158.50T"
  },
  "data": {
    "type": "best_difficulty",
    "address": "bc1q...",
    "difficulty": "158500000000000",
    "formattedDifficulty": "158.50T",
    "timestamp": "1734567890000"
  }
}
```

### 2. Device Status Notification

**When:** Mining device goes online or offline

**Unified Push Format:**
```
Device Online|Antminer S19 (worker1) at 12/18/24, 3:45 PM|
```

**FCM Format:**
```json
{
  "notification": {
    "title": "Device Back Online",
    "body": "Antminer S19 (worker1) at 12/18/24, 3:45 PM"
  },
  "data": {
    "type": "device_status",
    "address": "bc1q...",
    "status": "online",
    "isReturning": "true",
    "workerName": "worker1",
    "userAgent": "Antminer S19",
    "sessionId": "abc123def456",
    "timestamp": "1734567890000"
  }
}
```

### 3. Block Found Notification

**When:** Your address finds a valid block

**Unified Push Format:**
```
New Block Found!|Block height 820450|158T
```

**FCM Format:**
```json
{
  "notification": {
    "title": "New Block Found!",
    "body": "Block height 820450"
  },
  "data": {
    "type": "block_found",
    "address": "bc1q...",
    "height": "820450",
    "difficulty": "158T",
    "timestamp": "1734567890000"
  }
}
```

---

## Rate Limiting

Each subscription has a **5-minute minimum interval** between notifications of the same type. This prevents notification spam if you're constantly mining.

**Example:**
- 10:00 AM - Best difficulty notification sent ✓
- 10:01 AM - Difficulty increases again → notification blocked (too soon)
- 10:05 AM - Difficulty increases again → notification sent ✓

**Note:** Rate limiting is per subscription, so you can have different rates for different endpoints.

---

## Error Responses

### Invalid Address
```json
{
  "statusCode": 400,
  "message": "Missing required fields: address, endpoint",
  "error": "Bad Request"
}
```

### Invalid FCM Token Format
```json
{
  "statusCode": 400,
  "message": "Invalid FCM token format",
  "error": "Bad Request"
}
```

**FCM Token Requirements:**
- Length: 152-163 characters
- Characters: a-z, A-Z, 0-9, :, _, -

### Endpoint Not Found
```json
{
  "statusCode": 400,
  "message": "Failed to configure push notifications",
  "error": "Bad Request"
}
```

---

## Best Practices

### For Unified Push Users

1. **Choose a reliable distributor:**
   - **ntfy.sh** - Simplest, free, no account needed. Open ntfy app and subscribe to a topic name, you get the endpoint URL
   - **Pushbullet** - Requires account setup, get endpoint from account settings
   - **Self-hosted** - Run your own distributor for maximum control (see https://unifiedpush.org/)

2. **Get your endpoint from the distributor:**
   - ntfy.sh: Subscribe to topic in app, endpoint is `https://ntfy.sh/topic-name`
   - Pushbullet: Get endpoint from account/settings
   - Self-hosted: Get from your distributor configuration
   - **This is the endpoint you register with BlitzPool**

3. **Test your endpoint:**
   ```bash
   # Send a test message to ntfy.sh to verify it works
   curl -d "Test notification" https://ntfy.sh/my-mining-alerts
   ```

4. **Monitor notification delivery:**
   - Check the status endpoint regularly
   - Keep track of `lastNotificationAt` to verify you're receiving notifications

### For FCM Users

1. **Handle token refresh:**
   - FCM tokens can expire or change
   - Refresh tokens monthly or when your app restarts
   - Re-register with `/api/push/fcm/register` when token changes

2. **Request permissions:**
   - Always ask user permission before sending notifications
   - iOS and Android require explicit opt-in

3. **Test in development:**
   - Use Firebase emulator for local testing
   - Send test notifications to verify setup

4. **Secure token handling:**
   - Never log tokens to console (production)
   - Use secure storage for token persistence
   - Don't share tokens across devices

### General Tips

1. **Enable only what you need:**
   - Reduce notification spam
   - Focus on alerts that matter to you

2. **Monitor regularly:**
   - Check status endpoint to confirm subscriptions are active
   - Verify `lastNotificationAt` is recent

3. **Keep contact info updated:**
   - If your address changes, update subscriptions
   - Remove old endpoints/tokens to reduce clutter

4. **Test notifications:**
   - Make a small change that triggers notification
   - Confirm you receive it before relying on service

---

## Troubleshooting

### Not Receiving Notifications?

1. **Check if subscriptions are active:**
   ```bash
   curl http://blitzpool.example.com/api/push/status/YOUR_ADDRESS
   ```
   - Verify `subscriptionCount` > 0
   - Check notification type is enabled (e.g., `bestDiffNotificationsEnabled: true`)

2. **For Unified Push (ntfy):**
   - **First, verify your endpoint is correct:** Check your ntfy app/account, make sure the topic name and endpoint URL match what you registered with BlitzPool
   - Test endpoint manually: `curl -d "Test" https://ntfy.sh/YOUR_TOPIC`
   - Check if topic is publicly accessible (some firewalls or VPNs might block)
   - Verify endpoint URL is correct in status response (should match what distributor gave you)

3. **For FCM:**
   - Check token hasn't expired (refresh monthly)
   - Verify token format matches pattern (152-163 alphanumeric)
   - Ensure mobile app has permission to receive notifications
   - Check device isn't in Do Not Disturb mode

4. **Check timing:**
   - Best difficulty: checks every 60 seconds
   - Rate limit: 5 minutes between same-type notifications
   - Device/Block notifications: triggered on events (not regularly)

### "Invalid FCM Token Format"

- Token must be 152-163 characters
- Only alphanumeric, colons (:), underscores (_), and hyphens (-) allowed
- Make sure you're copying the full token from your mobile app

### "Failed to register" (500 error)

- Check that address is valid (62-character Bitcoin address)
- Verify endpoint URL is properly formatted (for Unified Push)
- Ensure token isn't already registered (register response will show existing subscriptions)

---

## API Reference Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/push/register` | Register Unified Push endpoint |
| POST | `/api/push/unregister` | Remove Unified Push subscription |
| POST | `/api/push/fcm/register` | Register FCM token |
| POST | `/api/push/fcm/unregister` | Remove FCM token |
| POST | `/api/push/configure` | Update notification preferences |
| GET | `/api/push/status/:address` | Check subscription status |

---

## Support

For issues or questions about push notifications:
1. Check this guide first
2. Verify your address and endpoint/token are correct
3. Review error messages for specific problems
4. Check the troubleshooting section above

Still having issues? Contact BlitzPool support with:
- Your Bitcoin address
- Subscription type (Unified Push or FCM)
- What notifications you're trying to receive
- Recent notification status response
