# PPLNS Payouts — How They Work

End-to-end mechanics of how a miner's share turns into sats in their wallet, using the **signed credit/debit ledger**.

- Engine: `src/services/pplns.service.ts`
- Coinbase math: `src/services/coinbase-distribution.ts`
- Share storage: Redis sorted set `pplns:shares` + aggregate `pplns:window:by-address`
- Ledger storage: PostgreSQL `pplns_balance` (signed) + `pplns_payout_history` (audit)
- Abandonment sweep: `src/services/dust-sweep.service.ts` (pair-aware)

---

## 1. The Share Window

PPLNS keeps a **sliding window** of the most recent shares across all miners. Payouts are split according to who contributed how much work to *that window* at the moment a block is found.

### Window size

```
windowSize = 4 × networkDifficulty   (PPLNS_WINDOW_FACTOR = 4)
```

Both numbers are in diff1-equivalent work. The factor of 4 means a miner's shares typically stay in the window for the time it takes the pool to find ~4 network-difficulty worth of work — at current mainnet difficulty, that's several days to weeks depending on pool hashrate.

### Critical: the window does NOT reset after a block is found

This is real PPLNS, not PROP. Shares stay in the window and continue to earn from *future* blocks until they fall out the back as new shares arrive. This is what protects the pool against pool-hopping — a miner can't join just before a block is found and leave right after, because their payout depends on sustained contribution over the window's lifetime.

### What's stored

Each accepted share is one entry in Redis sorted set `pplns:shares`:

```
entry  = "{address}:{difficulty}:{timestamp}"
score  = monotonically increasing counter (pplns:counter)
```

Plus two aggregates maintained in lock-step with the raw set so hot-path reads don't scan every share:

- `pplns:window:total` — running sum of diff-1 work in the window
- `pplns:window:by-address` — hash of per-address diff-1 sums

### Trimming

After every accepted share (`recordShare`):

1. Insert the new entry.
2. Increment `pplns:window:total` and `pplns:window:by-address:{addr}` by the share's difficulty.
3. While `windowTotal > windowSize`: remove oldest 100 entries in a batch and decrement the aggregates.
4. Every 1000 trims: recalculate both aggregates from scratch to correct float drift.

### Network difficulty updates

`networkDifficulty` is updated whenever a new block template arrives (`StratumV1JobsService.newMiningJob$`). When difficulty rises, the window grows and nothing is trimmed immediately; when it falls, the next share insert will trigger trimming down to the new size.

---

## 2. Recording a Share

A share enters the PPLNS window only when:

- The stratum port it came in on has `payoutMode: 'pplns'` (configured via `PPLNS_PORT`).
- The share is **accepted** (valid signature / valid PoW above the session target).
- For SV1: called from `StratumV1Client.ts`.
- For SV2 (standard + extended): called from `StratumV2Client.ts`.

Rejected, stale, or below-target shares do **not** enter the window.

The share's contribution is its actual submission difficulty, not the session difficulty — a miner whose session target is diff 1024 and who submits a share that happens to hash to diff 8192 is credited for 8192.

`recordShare` also calls `balanceService.touchLastAcceptedShareAt(address)` so the abandonment sweep can tell active miners from dormant ones.

---

## 3. The Signed Credit/Debit Ledger

Every miner row in `pplns_balance` has a **signed** `balanceSats` field:

```
balanceSats  >  0  →  Pool owes the miner (pending credit)
balanceSats  <  0  →  Miner owes the pool (outstanding debit)
balanceSats  == 0  →  No open claim in either direction
```

**Pool-neutrality invariant**: `sum(balanceSats)` across the whole table stays close to `0`. It drifts by at most `N` sats per block (N = miners in that block) from floor-rounding — see §5b below.

### How a balance becomes non-zero

Exactly three situations create ledger entries, all in one transaction with `onBlockFound`:

| Situation | Recipient balance | Counterparty balance | Matching? |
|---|---|---|---|
| Miner X sub-dust this block (rawFair < 546 sats) | `X.balance += rawFair` (credit) | Residuum sweep distributes +rawFair on-chain to active kept miners with matching `-rawFair × share_i / total_shares` debits | ✅ 1:1 |
| Miner X weight-trimmed this block (rawFair ≥ 546 but didn't fit) | `X.balance = target = rawFair + oldBalance` (credit) | Trim-bonus redistribution (Phase 5a) sends X's target proportionally to kept active miners with matching debits | ✅ 1:1 |
| Floor-rounding residuum (1–N sats per block) | — | Distributed proportionally to kept active miners with matching debits | ❌ creates bounded drift |

### How a balance settles

- **Credit (`> 0`) settles** when the miner's `balanceSats + rawFair ≥ dust` in a subsequent block — the credit is added to their on-chain payout, balance resets to 0.
- **Debit (`< 0`) settles** when the miner mines again — their target becomes `rawFair + balanceOld` (which is *less* than rawFair), so they automatically repay via reduced on-chain payout, balance resets to 0.

Everything happens in the coinbase of the *next block they participate in*. No pool wallet is involved at any point.

---

## 4. Building the Coinbase Payout Distribution

`getPayoutDistribution(blockRewardSats)` is called every time the pool builds a new mining job. It returns a list of `{ address, percent, sats }` entries ready to become coinbase outputs, and persists a snapshot so `onBlockFound` uses the exact same split.

Implementation: `buildCoinbaseDistribution()` in `coinbase-distribution.ts`. Five phases:

### Phase 1–2 — Raw fair share + target

For every address with shares *or* a non-zero balance:

```
rawFair(m) = floor(shares(m) / totalShares × rewardForMiners)
target(m)  = rawFair(m) + balanceOld(m)
```

Miners with a balance but no current shares (pending-only) use `shares = 0`, so `target(m) = balanceOld(m)` for them.

### Phase 3 — Eligibility + Phase 4 — Weight-budget trim

Eligible = `target ≥ DUST_LIMIT_SATS` (546 sats). Sort eligible by target descending. The top `maxMinerOutputs` are **kept** (placed as coinbase outputs); any eligible overflow is **trimmed**. Sub-dust miners (target < 546) are neither kept nor trimmed — their target carries forward as their new balance.

```
maxMinerOutputs = floor(
    (weightBudget - COINBASE_BASE_WEIGHT - COINBASE_WITNESS_COMMITMENT_WEIGHT
                  - feeOutputCount × COINBASE_OUTPUT_WEIGHT)
    / COINBASE_OUTPUT_WEIGHT
)
```

With defaults (`weightBudget=50_000`, `base=328`, `witness=188`, `output=172`) this fits ~286 miners plus the fee output.

### Phase 5a — Trim-bonus redistribution

Trimmed miners' summed `target` goes to kept active miners proportionally to their shares. Each bonus recipient gets:

- `onChain += trimmedTotal × share_i / totalKeptActiveShares`
- `balanceNew -= bonus` (they now "owe" the pool that much — settled from their own rawFair in a future block)

The trimmed miners themselves carry their `target` forward as `balanceNew`.

### Phase 5a.5 — Solvency cap (abandoned-debtor guard)

If after Phase 5a `sum(kept.onChain) > rewardForMiners`, an abandoned debtor has left a positive credit in the kept set without a matching backing debit. We cannot emit more coinbase than the reward allows. Solvency cap:

1. Compute `overshoot = sum(kept.onChain) - rewardForMiners`.
2. Find kept miners with `balanceOld > 0` (credit-claimers).
3. Proportionally cut their on-chain amounts by `overshoot × balanceOld_i / totalCredit`; the uncovered portion stays as their new balance (claim delayed, never denied).

Active miners with `shares > 0` keep their full rawFair — they do NOT pay for someone else's abandonment. The active debtors' debits stay in the ledger until the debtors themselves return or go dormant.

Fee-100 % fallback only triggers in the mathematically-impossible case of overshoot-without-credit-claimer (defence in depth).

### Phase 5b — Residuum distribution

Any remaining positive `residuum = rewardForMiners - sum(kept.onChain)` comes from Phase 1 floor-rounding plus sub-dust rawFair accumulation. Distributed to kept active miners proportionally to their shares, each recipient picking up a matching debit on `balanceNew`. Floor-rounding tail (< `numActiveKept` sats) goes to the largest active miner.

### Phase 6 — Assemble payouts + `balanceAfter`

`payouts` is sorted with the fee first, then miners by on-chain desc. `balanceAfter` is a `Map<address, signedSats>` of every miner whose ledger state started or ended non-zero — consumed by `onBlockFound` to write absolute balance values.

### Fallback distribution

If anything goes wrong (Redis down, empty window, zero totalDiff), `fallbackDistribution` sends 100% to the pool fee address. No fee address configured → empty array → coinbase builder falls through to solo output.

---

## 5. Block Found

When a share ≥ network difficulty is submitted and Bitcoin Core's `submitblock` accepts it, `onBlockFound(blockHeight, blockRewardSats)` fires.

### Safety gates

1. Enabled + Redis check (silent no-op if not).
2. Cache invalidation (`cachedDistribution = null`).
3. Concurrency guard (`blockFoundInProgress`), cleared in `finally`.
4. Idempotency pre-check: `findOneBy({ blockHeight })` on `pplns_payout_history` — skips replay.

### Snapshot-path bookkeeping

The snapshot written by `getPayoutDistribution` is the source of truth. One Postgres transaction writes everything atomically:

1. Load every balance row whose address appears in `snapshot.balanceAfter` or `snapshot.distribution` (single `IN`-list query).
2. For each `(addr, newBalance)` in `balanceAfter`: **absolute write** — `balance.balanceSats = newBalance`. No delta math, no double-clear risk on replay (the pre-check handles replay anyway).
3. For each coinbase entry: write `pplns_payout_history` row with `inCoinbase: true`, `rowType: 'coinbase'`, `paidSats: entry.sats`. Non-fee miners also bump `totalPaidSats`.
4. For each address in `balanceAfter` but not in the coinbase distribution: write `rowType: 'pending'` audit row (zero paidSats) — documents that their ledger moved even though they didn't get an on-chain output.
5. For each address in the current window but not in `snapshot.consideredAddresses` (a late arriver): audit-only `'pending'` row. Their shares remain in the sliding window and will count toward the next block's snapshot.

If the pool was restarted between snapshot-write and block-found, the snapshot survives (1 h Redis TTL backed by AOF). If the snapshot's `blockRewardSats` mismatches the real reward, the snapshot is discarded and the fallback path runs.

### Fallback: `applyDistributionWithoutSnapshot`

Used only if the snapshot is missing (first block after startup, Redis flushed) or its reward disagrees with the real block. Rebuilds the distribution against the *current* window and *current* balances, then applies the same transactional path. The on-chain coinbase may not exactly match what we compute here if shares changed between template-send and block-find, but the ledger converges to "close enough" based on current state.

### Idempotency & replay

Two layers:

- **Pre-check**: `findOneBy({ blockHeight })` on history. If the block was already processed, skip entirely.
- **Unique index**: `UQ_pplns_payout_history_block_address` on `(blockHeight, address)`. A pathological replay race that slips past the pre-check hits the index and throws `23505`, which is caught and logged.

A crash mid-transaction rolls everything back. Replay after restart re-runs from scratch.

---

## 6. Abandonment Sweep

`DustSweepService.sweep()` runs daily at 03:00 UTC. Two independent passes:

### 6.1 PPLNS pair-sweep (signed)

Finds all rows whose `balanceSats != 0` and `lastAcceptedShareAt` is older than `ABANDONED_BALANCE_DAYS` (default 90 = 3 months). Splits them by sign, sorts largest-first, then greedy-matches credit ↔ debit pairs:

```
for each (credit, debit) pair:
    amount = min(credit.balance, -debit.balance)
    credit.balance -= amount
    debit.balance  += amount
    write one 'dust-sweep' audit row per side, paidSats = amount
    if credit.balance == 0: delete credit row
    if debit.balance  == 0: delete debit row
```

Matched pairs cancel cleanly — `sum(balances)` is preserved. Unpaired remainders stay in the ledger until a counterparty becomes available (either a matching dormant row or the miner's own return to mining).

### 6.2 Group-Solo legacy dust sweep

Group-Solo balances stay on the simpler "positive pending" model (no trim / no sub-dust by design — groups are capped small enough that every member's share clears dust every block). Dormant rows with `0 < pendingSats < 546` past `DUST_SWEEP_DORMANT_DAYS` (default 30) are deleted with an audit row.

### Why pair-sweeping rather than redistributing to active miners

When an abandoned debtor's physical sats have already been paid to them on-chain in a past block, the pool is non-custodial and cannot recover them. The only ledger-neutral action is to cancel their debit against an equal abandoned credit. Any redistribution to active miners would have to come out of active miners' own fair-share budget, which violates the "active miners never pay for abandoners" guarantee.

---

## 7. Configuration

### 7.1 App ENV variables

| Variable | Default | Purpose |
|---|---|---|
| `PPLNS_PORT` | — | Stratum port that enables PPLNS mode. Absence disables PPLNS entirely. |
| `PPLNS_START_DIFFICULTY` | default port's initial | VarDiff seed for PPLNS-port miners |
| `PPLNS_TARGET_SHARES_PER_MINUTE` | default port's target | VarDiff retarget rate |
| `PPLNS_FEE_ADDRESS` | — (empty) | Pool fee destination. Absence disables the fee output. |
| `PPLNS_FEE_PERCENT` | `2` | Pool fee percent (float). Applied before miner distribution. |
| `PPLNS_COINBASE_WEIGHT_BUDGET` | `50000` (WU) | Upper bound on coinbase weight. Must be ≤ `blockreservedweight`. |
| `ABANDONED_BALANCE_DAYS` | `90` | PPLNS pair-sweep inactivity threshold (3 months) |
| `DUST_SWEEP_DORMANT_DAYS` | `30` | Group-solo legacy dust-sweep inactivity threshold |
| `DUST_SWEEP_ENABLED` | `true` | Master switch for both sweeps |

### 7.2 Bitcoin Core (`bitcoin.conf`)

| Setting | Recommended | Purpose |
|---|---|---|
| `blockreservedweight` | `50000` | `PPLNS_COINBASE_WEIGHT_BUDGET` must not exceed this. |

### 7.3 Hardcoded constants (`coinbase-distribution.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `PPLNS_WINDOW_FACTOR` | `4` | Window size = 4 × network difficulty |
| `DUST_LIMIT_SATS` | `546` | Conservative dust floor (P2PKH, works for all output types) |
| `COINBASE_BASE_WEIGHT` | `328` WU | Base + locktime + witness-reserved; headroom for 3-byte output-count varint at ≥ 253 outputs |
| `COINBASE_OUTPUT_WEIGHT` | `172` WU | Per P2TR output (conservative; P2WPKH is 124) |
| `COINBASE_WITNESS_COMMITMENT_WEIGHT` | `188` WU | Segwit-commitment OP_RETURN |
| `DEFAULT_COINBASE_WEIGHT_BUDGET` | `50_000` | Fallback when env var is missing/invalid |

---

## 8. Worked Example — with signed ledger

Assume:
- Network difficulty → window fits 4 active miners comfortably
- Block reward = 3.125 BTC = 312,500,000 sats
- Fee: 2 % to `bc1qpool...`
- Pool-neutral ledger before block:

| Miner | balance_old |
|---|---|
| Alice | 0 |
| Bob | 0 |
| Charlie | +1500 (accumulated sub-dust credit) |
| Dave | -1500 (matching debit from prior residuum bonus) |

Shares this block:

| Miner | diff | share fraction |
|---|---|---|
| Alice | 200 | 50 % |
| Bob | 150 | 37.5 % |
| Dave | 50 | 12.5 % |

Charlie has no current shares (pending-only credit claimer).

### Phase 1–2

```
feeSats         = floor(0.02 × 312_500_000)   = 6_250_000
rewardForMiners = 312_500_000 - 6_250_000     = 306_250_000

Alice.rawFair   = floor(0.500 × 306_250_000)  = 153_125_000
Bob.rawFair     = floor(0.375 × 306_250_000)  = 114_843_750
Dave.rawFair    = floor(0.125 × 306_250_000)  = 38_281_250
Charlie.rawFair = 0

Alice.target    = 153_125_000
Bob.target      = 114_843_750
Dave.target     = 38_281_250 - 1500    = 38_279_750
Charlie.target  = 0 + 1500              = 1500
```

### Phase 3–4

All four targets ≥ 546. Budget easily fits 4 miner outputs. Kept = {Alice, Bob, Dave, Charlie}.

### Phase 5a

Nothing trimmed → no bonus redistribution.

### Phase 5a.5

```
sum(kept.onChain) = 153_125_000 + 114_843_750 + 38_279_750 + 1500 = 306_250_000
overshoot = 306_250_000 - 306_250_000 = 0   →   no cap needed
```

Dave's -1500 debit and Charlie's +1500 credit cancel exactly in the same block.

### Phase 5b

```
residuum = 306_250_000 - 306_250_000 = 0   →   no action
```

### Final coinbase

| Output | Address | Sats |
|---|---|---|
| 0 | `bc1qpool...` (fee) | 6,250,000 |
| 1 | Alice | 153,125,000 |
| 2 | Bob | 114,843,750 |
| 3 | Dave | 38,279,750 |
| 4 | Charlie | 1,500 |

`balanceAfter` records everything going to 0: Alice=0, Bob=0, Dave=0, Charlie=0. Sum preserved, all open claims settled in one block.

---

## 9. Failure modes & edge cases

- **Redis down** → `recordShare` silently drops; `getPayoutDistribution` returns fallback (100 % to fee). Already-stored shares survive if Redis comes back, but shares during the outage are lost.
- **Empty window** (pool just started) → fallback distribution; first block pays 100 % to fee.
- **No fee address configured** → fee output omitted; residuum stays in the ledger as debit on the largest active miner.
- **Float drift** in aggregates → auto-corrected every 1000 trims.
- **Concurrent block-found** → `blockFoundInProgress` flag drops the second call.
- **Snapshot missing / reward mismatch** → fall back to `applyDistributionWithoutSnapshot`, which recomputes from the current window. Logged as a warning.
- **EdgeCase A — abandoned debtor, active credit-claimer** → Phase 5a.5 solvency cap delays the credit claim without paying fee extra. Claim lives in the ledger until the debtor returns or goes dormant (pair-swept).
- **EdgeCase B — abandoned credit with no abandoned debit, only active debitors** → sweep leaves the credit row in place; active debitors' debits stay until they abandon too. Both cancel on future sweep runs.
- **Pool-neutrality drift** → bounded by `numMiners` sats per block from floor-rounding, concentrated on the largest active miner. Negligible in practice (<100 sats/day) and neutralised when the miner abandons or a matching credit is swept.
