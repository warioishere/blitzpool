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

PPLNS status for a single miner address, exposing the **signed credit/debit ledger**: what the pool owes (or what the miner owes the pool), plus lifetime totals and current window share.

### Response

```json
{
  "balanceSats": 125000,
  "balanceLabel": "credit",
  "totalPaidSats": 8750000,
  "currentWindowDifficulty": 3500000,
  "currentWindowPercent": 28.36
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `balanceSats` | integer (signed) | Signed ledger balance for this address. `> 0` pool owes the miner (pending credit from sub-dust / trim). `< 0` miner owes the pool (outstanding debit from an earlier on-chain bonus, settled automatically the next time they mine). `0` no open claim in either direction. |
| `balanceLabel` | `'credit'` \| `'debit'` \| `'zero'` | Ready-to-render category for UI (green / red / neutral). Derived from `balanceSats`. |
| `totalPaidSats` | number | Lifetime sats paid out to this address on-chain via the PPLNS engine. |
| `currentWindowDifficulty` | number | This address's work in the current sliding window. |
| `currentWindowPercent` | number | This address's share of the window, 0–100. |

### Notes

- Returns zeros / `'zero'` for all fields if the address has never mined.
- Credits settle when `balanceSats + rawFair ≥ dust` in a subsequent block — the credit is added to the on-chain payout and balance resets to 0.
- Debits settle when the miner mines again — their target becomes `rawFair + balanceOld` (less than rawFair), and the reduced on-chain payout repays the debt.
- Address is not validated — an unknown address returns a valid `'zero'` response.

---

## `GET /api/pplns/:address/history`

Per-block payout history for a specific address, newest first. Includes both on-chain payouts and ledger-only events (credit accrual, pair-sweep cancellations) so the miner can trace their balance evolution block by block.

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
    "rowType": "coinbase",
    "createdAt": "2026-04-18T14:22:10.123Z"
  },
  {
    "id": 1392,
    "blockHeight": 891200,
    "address": "bc1q...",
    "paidSats": 0,
    "percent": 0,
    "inCoinbase": false,
    "rowType": "pending",
    "createdAt": "2026-04-18T13:40:02.512Z"
  },
  {
    "id": 1120,
    "blockHeight": -1761187200,
    "address": "bc1q...",
    "paidSats": 127,
    "percent": 0,
    "inCoinbase": false,
    "rowType": "dust-sweep",
    "createdAt": "2026-04-12T03:00:00.221Z"
  }
]
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Auto-increment primary key. |
| `blockHeight` | number | Real block height for `coinbase` / `pending` rows. `dust-sweep` rows encode negative Unix-seconds as a synthetic height so the `(blockHeight, address)` unique index stays collision-free across repeat sweeps. |
| `address` | string | Payout address. |
| `paidSats` | number | For `coinbase`: on-chain sats paid in the block. For `pending`: 0 (audit only — ledger moved, no on-chain output). For `dust-sweep`: absolute amount absorbed on this side of a pair-cancellation. |
| `percent` | number | This address's share of that block's coinbase distribution (`coinbase` rows only; 0 for `pending` / `dust-sweep`). |
| `inCoinbase` | boolean | `true` only for `rowType === 'coinbase'`. Legacy field; prefer `rowType`. |
| `rowType` | `'coinbase'` \| `'pending'` \| `'dust-sweep'` | Semantic category: on-chain payout / signed ledger change without on-chain output / abandonment pair-cancellation absorption. |
| `createdAt` | string (ISO 8601) | Row creation timestamp. |

### Notes

- Sorted `createdAt DESC`. Returns `[]` if the address has no payout history.
- Each block that affects the miner produces at least one row — one per rowType category if multiple categories apply (rare).
- `pending` rows document that the signed ledger balance changed without an on-chain output (sub-dust credit accrued, matching debit absorbed via reduced rawFair, or just a late-arrival audit).
- `dust-sweep` rows always come in pairs: one for the credit side, one for the debit side, sharing the same synthetic `blockHeight`.

---

## `GET /api/pplns/ledger`

Pool-wide signed-ledger summary. Gives an operator dashboard (or the UI's "PPLNS Info" page) everything needed to render "what does the pool owe and what is owed to it" in a single call.

### Response

```json
{
  "totalCreditSats": 12450,
  "totalDebitSats": 12418,
  "netDriftSats": 32,
  "creditHolderCount": 34,
  "debitHolderCount": 6,
  "abandonedCreditSats": 420,
  "abandonedDebitSats": 0,
  "lifetimePaidSats": 58421023547
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `totalCreditSats` | number | Sum of positive balances across every miner row (pool owes miners this much in total). |
| `totalDebitSats` | number | Sum of absolute negative balances (miners owe pool this much in total). |
| `netDriftSats` | number | Signed total: `totalCreditSats - totalDebitSats`. Hovers near 0 in a steady-state pool; persistent drift indicates floor-rounding accumulation on the largest miner (harmless, bounded by the sweep). |
| `creditHolderCount` | number | Row count with `balanceSats > 0`. |
| `debitHolderCount` | number | Row count with `balanceSats < 0`. |
| `abandonedCreditSats` | number | Subset of `totalCreditSats` sitting in rows whose `lastAcceptedShareAt` is older than `ABANDONED_BALANCE_DAYS` — candidates for pair-cancellation on the next daily sweep. |
| `abandonedDebitSats` | number | Same for debits. |
| `lifetimePaidSats` | number | Sum of `totalPaidSats` across every miner row — lifetime on-chain payouts through the PPLNS engine. |

### Notes

- In a steady-state pool `totalCreditSats ≈ totalDebitSats` (pool-neutrality, bounded floor-rounding drift).
- A big gap between `abandonedCreditSats` and `abandonedDebitSats` means the next sweep will be asymmetric: only the smaller side pair-cancels, the larger side stays in the ledger waiting for further counterparties.
- Computed with a single full-table SUM / COUNT scan. Acceptable up to ~100 k rows; at scale, consider caching with a short TTL.

---

## Example Calls

```bash
# Pool-wide status
curl http://localhost:3000/api/pplns/status

# Pool-wide signed-ledger summary
curl http://localhost:3000/api/pplns/ledger

# Full distribution (who's mining right now, in what proportion)
curl http://localhost:3000/api/pplns/distribution

# One miner's status (includes signed balance + balanceLabel)
curl http://localhost:3000/api/pplns/bc1qexampleaddr...

# One miner's last 20 payouts (coinbase + pending + dust-sweep rows)
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
