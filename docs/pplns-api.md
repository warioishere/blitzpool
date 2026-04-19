# PPLNS API

Read-only HTTP endpoints exposing PPLNS window state, share distribution, per-miner status, and payout history.

Controller: `src/controllers/pplns/pplns.controller.ts`
Service: `src/services/pplns.service.ts`
Global prefix (`main.ts:31`): `api` → all paths below are prefixed with `/api`.

All responses are JSON. No authentication.

---

## `GET /api/pplns`

Pool-wide PPLNS info — mirrors `/api/info` but filtered to addresses currently contributing to the PPLNS window. Designed for a "who's mining on the PPLNS pool right now" dashboard tile.

### Response

```json
{
  "enabled": true,
  "totalDifficulty": 12345678.9,
  "windowSize": 400000000,
  "shareCount": 1523,
  "minerCount": 42,
  "userAgents": [
    { "userAgent": "Bitaxe/2.1.15", "count": 28, "bestDifficulty": 524288, "totalHashRate": 18000000000000 },
    { "userAgent": "cpuminer-opt/3.22.2", "count": 14, "bestDifficulty": 2048, "totalHashRate": 300000000 }
  ]
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `enabled`, `totalDifficulty`, `windowSize`, `shareCount`, `minerCount` | — | Identical to `/api/pplns/status`. |
| `userAgents[]` | array | Per-user-agent aggregation, **restricted to addresses currently in the PPLNS window**. Ordered by `count` descending. |
| `userAgents[].userAgent` | string | Raw `user_agent` string as reported by the miner. |
| `userAgents[].count` | number | Number of active worker sessions running this firmware. |
| `userAgents[].bestDifficulty` | number | Highest best-diff any session with this user-agent has hit. |
| `userAgents[].totalHashRate` | number | Sum of live hashrate across all sessions with this user-agent. |

### Notes

- Only addresses with shares in the current window are included. Addresses that disconnected and whose shares already rolled off the window are not shown.
- The user-agent aggregation is taken from `ClientEntity` — same source as `/api/info.userAgents`, same fields.

---

## `GET /api/pplns/status`

Pool-wide PPLNS status: window size, total work in the window, and whether PPLNS is enabled at all.

### Response

```json
{
  "enabled": true,
  "totalDifficulty": 12345678.9,
  "windowSize": 400000000,
  "shareCount": 1523,
  "minerCount": 42
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | `true` if PPLNS is enabled **and** Redis is connected. When `false`, the other numbers will all be `0`. |
| `totalDifficulty` | number | Sum of diff1-equivalent work across all shares currently in the window (read from Redis key `WINDOW_TOTAL`). |
| `windowSize` | number | Target window size = `4 × networkDifficulty` (constant `PPLNS_WINDOW_FACTOR = 4`). Shares are trimmed once the window exceeds this. |
| `shareCount` | number | Number of individual share entries in the Redis sorted set. |
| `minerCount` | number | Number of distinct miner addresses contributing to the current window. |

### Notes

- `windowSize` grows with network difficulty and is recalculated whenever a new template arrives (`setNetworkDifficulty`).
- `totalDifficulty` can briefly exceed `windowSize` between a share insert and the next `trimWindow()` call.

---

## `GET /api/pplns/distribution`

Full breakdown of the current PPLNS window: every miner address and their percentage share of the window.

### Response

```json
[
  { "address": "bc1q...", "difficulty": 8000000, "percent": 64.82 },
  { "address": "bc1p...", "difficulty": 3500000, "percent": 28.36 },
  { "address": "bc1q...", "difficulty":  842000, "percent":  6.82 }
]
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `address` | string | Miner's BTC payout address. |
| `difficulty` | number | Sum of diff1-equivalent work this miner has in the window. |
| `percent` | number | `(difficulty / totalDifficulty) × 100`. Sorted descending. |

### Notes

- Empty array (`[]`) when Redis is unavailable or the window is empty.
- This is the exact distribution that will be used to split the coinbase on the next block-found event (subject to the fee output and weight budget).
- Sums of `percent` will equal 100% (modulo floating-point rounding).

---

## `GET /api/pplns/chart`

Historical hashrate time-series aggregated across all current PPLNS participants. Drop-in compatible with `/api/info/chart` — same output shape, same 10-minute slots, same share-based hashrate formula.

### Query Parameters

| Param | Type | Default | Values | Meaning |
|---|---|---|---|---|
| `range` | string | `1d` | `1d`, `3d`, `7d` | Lookback window. |

### Response

```json
[
  { "label": "2026-04-19T09:50:00.000Z", "data":  800000000000 },
  { "label": "2026-04-19T10:00:00.000Z", "data":  850000000000 },
  { "label": "2026-04-19T10:10:00.000Z", "data":  910000000000 }
]
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `label` | string (ISO 8601) | Slot end-time. 10-minute granularity, same as `/api/info/chart`. |
| `data` | number | Sum over all current PPLNS participants of each miner's hashrate at that slot. Hashrate is computed from their share contribution: `shares × DIFFICULTY_1 / 600` — matches `/api/client/:address/chart` semantics. |

### Notes

- The "participant set" is snapshot at request time (= current PPLNS window). If a miner was in the window earlier but not now, their contribution at those earlier slots is **not** included.
- Labels are sparse: a slot only appears if at least one current participant had shares in it.
- Empty array when the current window has no participants.
- Summed series may look jagged compared to `/api/info/chart` because it's a subset of the pool — don't interpret differences as a bug.

---

## `GET /api/pplns/:address`

PPLNS status for a single miner address: pending payout, total paid to date, and current share of the window.

### Response

```json
{
  "pendingSats": 125000,
  "totalPaidSats": 8750000,
  "currentWindowDifficulty": 3500000,
  "currentWindowPercent": 28.36
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `pendingSats` | number | Sats credited to this address but not yet paid out (from `pplns_balance` table). Used when a block-found payout couldn't include the miner in the coinbase directly (e.g. dust, weight budget exceeded). |
| `totalPaidSats` | number | Lifetime sats paid to this address. |
| `currentWindowDifficulty` | number | This address's work in the current window. |
| `currentWindowPercent` | number | This address's share of the window, 0–100. |

### Notes

- Returns zeros for all fields if the address has never mined or is not currently in the window.
- `pendingSats` + `totalPaidSats` is the authoritative lifetime view; `currentWindowPercent` is ephemeral and changes as the window rolls.
- Address is not validated — an unknown address returns a valid zero response.

---

## `GET /api/pplns/:address/history`

Per-block payout history for a specific address, newest first.

### Query Parameters

| Param | Type | Default | Max | Meaning |
|---|---|---|---|---|
| `limit` | int | 50 | 200 | Number of history entries to return. Clamped to `[1, 200]`. |

### Response

```json
[
  {
    "id": 1423,
    "blockHeight": 891204,
    "address": "bc1q...",
    "paidSats": 320000,
    "percent": 6.4,
    "inCoinbase": true,
    "createdAt": "2026-04-18T14:22:10.123Z"
  }
]
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Auto-increment primary key. |
| `blockHeight` | number | Height of the block this payout is for. |
| `address` | string | Payout address. |
| `paidSats` | number | Amount paid to this address for this block. |
| `percent` | number | This address's share of that block's coinbase distribution. |
| `inCoinbase` | boolean | `true` if the payout went directly into the block's coinbase output; `false` if credited to `pendingSats` instead (dust, weight budget, etc.). |
| `createdAt` | string (ISO 8601) | Row creation timestamp. |

### Notes

- Sorted `createdAt DESC`. Returns `[]` if the address has no payout history.
- Each block produces one row per paid address, so history rows can be compared across addresses by `blockHeight`.

---

## Example Calls

```bash
# Pool-wide status
curl http://localhost:3000/api/pplns/status

# Full distribution (who's mining right now, in what proportion)
curl http://localhost:3000/api/pplns/distribution

# One miner's status
curl http://localhost:3000/api/pplns/bc1qexampleaddr...

# One miner's last 20 payouts
curl "http://localhost:3000/api/pplns/bc1qexampleaddr.../history?limit=20"
```

---

## Related Config (ENV)

| Variable | Purpose |
|---|---|
| `PPLNS_PORT` | Stratum port that routes into PPLNS mode. |
| `PPLNS_FEE_ADDRESS` | Pool fee destination (gets its own coinbase output). |
| `PPLNS_FEE_PERCENT` | Pool fee percentage applied before miner distribution. |
| `PPLNS_COINBASE_WEIGHT_BUDGET` | Max additional weight the PPLNS outputs may add to the coinbase (must stay under `blockreservedweight` in bitcoin.conf, default 50000). |
