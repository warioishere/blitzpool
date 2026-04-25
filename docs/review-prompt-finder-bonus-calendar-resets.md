# Review Prompt — Group-Solo Finder-Bonus & Calendar-Aligned Resets

You are a senior backend / Bitcoin / pool-software reviewer brought in cold. Read the listed files end-to-end, then audit the changes for **functional bugs, security issues, edge cases the implementer missed, and robustness problems**. Be adversarial — find what's broken, not what's pretty.

## Context

`blitzpool` is a NestJS pool with a "group-solo" payout mode (PROP-style coinbase split among friend-group members, window resets per block). Two related features were added in one work-session to a feature branch:

1. **Finder-bonus per-miner coinbase**: each member's stratum session gets a coinbase template that names their own address as the recipient of a configurable absolute-sats bonus output. The bonus comes out of the miner-cut (not the fee, not new sats), reducing every member's proportional share. Per-miner snapshots in Redis (`groupsolo:{groupId}:snapshot:{finderAddress}`) so `onBlockFound` can match the on-chain coinbase exactly.
2. **Calendar-aligned scheduled resets**: replaces the old "every N days from last reset" semantics with proper calendar boundaries — daily=admin's-end-of-day, weekly=admin's-Sunday-end, monthly=last-day-of-actual-calendar-month, custom=N-days. All in admin's browser timezone (sent with the PATCH).

Both features were end-to-end tested by the implementer; 753 jest tests pass (incl. 5 regtest specs against real Bitcoin Core 29.0).

## Out of scope (already discussed, not your concern)

The known sub-second race between "pool wrote new snapshot" and "miner finds block on the previous job they hadn't yet switched away from" — probability ~1:6M. Don't mention this. Find OTHER issues.

## Files to read

### Backend (NestJS, TypeScript, CommonJS)
Repo root: `/home/warioishere/github_repos/blitzpool`

Core math + service:
- `src/services/coinbase-distribution.ts` — pure-function 5-phase coinbase math; finder-bonus is the new feature here
- `src/services/group-solo.service.ts` — per-finder snapshots, getPayoutDistribution, onBlockFound, deleteAllSnapshots via SCAN, scheduledRoundReset
- `src/services/group.service.ts` — updateRoundResetConfig validation
- `src/services/group-round-reset.service.ts` — cron expressions per preset, fireIfDue, computeNextResetAt helper

Stratum integration (call sites):
- `src/models/StratumV1Client.ts` — search for `groupSoloService` (look at job build + share submit)
- `src/models/StratumV2Client.ts` — same; both standard + extended channel paths
- `src/app.controller.ts` — `clientBlockTemplate` endpoint passes finderAddress

HTTP surface:
- `src/controllers/pplns-group/pplns-group.controller.ts` — PATCH /pplns/groups/:id/settings, publicGroupView includes nextResetAt

ORM + migration:
- `src/ORM/pplns-group/pplns-group.entity.ts` — schema (note `roundResetPreset` is new)
- `src/migrations/1778000000000-AddGroupRoundResetPreset.ts` — backfill for existing groups
- `src/migrations/1777800000000-AddGroupRoundResetConfig.ts` — earlier migration for context

Tests:
- `src/services/group-solo.service.spec.ts` — finder-bonus tests at the bottom
- `src/services/group-round-reset.service.spec.ts` — preset + computeNextResetAt
- `src/services/group.service.spec.ts` — updateRoundResetConfig validation
- `src/services/group-solo-regtest.spec.ts` — bonus-mode end-to-end against Core (second `it()` block)

### UI (Angular)
Repo root: `/home/warioishere/github_repos/blitzpool-ui`

- `src/app/services/pplns-group.service.ts` — types `PplnsGroup`, `PplnsGroupRoundResetSettings`, error codes
- `src/app/components/payout-group/payout-group-admin.component.ts` + `.html` — admin form, sends `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `src/app/components/payout-group/payout-group-page.component.ts` — member-card countdown reads server-supplied `nextResetAt`

## What to look for

For each item, read the relevant code, decide if it's a real issue, and write a short finding (severity + repro + suggested fix). If you can't decide without running code, say so explicitly.

### Functional correctness
- Does the per-finder snapshot key collision (multiple workers from the same address) lose state? E.g., alice has worker1 + worker2, both call `getPayoutDistribution('grp-1', reward, alice_addr)` concurrently — same snapshot key, last write wins. Is that safe?
- `buildCoinbaseDistribution` Phase 5a.5 (solvency cap) — does the bonus output participate correctly? The cap walks `kept` (proportional outputs) and reduces credit-claimers. The bonus output is a separate emit (not in `kept`). Can the cap miscount the on-chain total because the bonus isn't in `preliminaryOnChain`?
- `onBlockFound` reads snapshot keyed by `finderAddress`. What happens if an attacker submits a winning share with someone else's address as `name.worker`? The address auth path normalizes; but if the snapshot lookup is keyed by the auth'd address and the block was actually mined on a template with a DIFFERENT bonus recipient, would the lookup mismatch?
- The `bonusEmitted = cappedBonusSats >= minPayout` gate: if `wantBonusSats=0` (no bonus configured), this is correctly false. But if `wantBonusSats < minPayout` (e.g., admin sets 100 sats), bonus is silently dropped. Is the admin notified? Should validation reject sub-`minPayout` configurations at PATCH time?
- Calendar preset = `monthly`, group's `lastRoundResetAt` is on Feb 28 23:55 (admin TZ). The cron's next fire is March 1 00:00 — only 5 minutes later. Will `scheduledRoundReset` skip it (60s anti-double-fire) or fire it? Is that the intended semantics?
- Calendar preset = `weekly`, hard-coded Monday-start. Admins from cultures with Sunday-start (US/IL/JP) — does the UI label match the cron behavior? Misleading UX or actual bug?

### Edge cases
- One-member group with bonus enabled: bonus is paid to the only member, `prop_self = (reward - fee - bonus)`, total = `reward - fee`. Same as no-bonus. Useless config but not broken — is it documented?
- Group has 0 active members at template-build time but `getPayoutDistribution` is called: empty Redis window → `fallback()` → fee 100%. Does the snapshot still get written? At what key (`__none__` or member's addr)?
- `removeMemberState` (admin kick) during a round with active per-finder snapshot for the kicked member: is their snapshot deleted? Or does it survive until the round resets / 1h TTL expires? If it survives, what happens if they reconnect with the same address before TTL?
- `dissolveGroup` while a member has an active stratum session mining on a recent template: the session might call `getPayoutDistribution` after dissolve. What does `groupRepo.findOneBy` return for a dissolved group? Does the bonus path handle null entity gracefully?
- Migration `1778000000000-AddGroupRoundResetPreset.ts` backfills `preset='custom'` for groups with `intervalDays IS NOT NULL`. What if such a group also has `roundResetTimezone IS NULL` (impossible by current validation, but possible from older entity state)? `applyConfig` skips scheduling silently — is that surfaced anywhere?
- `Intl.DateTimeFormat().resolvedOptions().timeZone` returning something the cron library doesn't accept (e.g., a deprecated alias or local-only tz). The UI fallback to UTC is in a `try/catch` — verify the catch actually triggers in practice and the server's `isValidTimezone()` rejects appropriately.
- `computeNextResetAt` for `custom` walks `nextDates(intervalDays + 2)` — for intervalDays=365 that's 367 dates. Does the cron lib actually return that many? What's the perf?
- `scheduledRoundReset` (Variant B): wipes ALL pending balances. If a member is owed sats from prior sub-dust accumulation, those are forfeit. Documented behavior — but is the admin warned in the UI before clicking save on a fresh "weekly" config?
- The 60s anti-double-fire guard: `if (Date.now() - lastResetAt < 60_000)`. If a block-found wipes at 23:59:30 (admin TZ), and the cron fires at 00:00:00 (= 30s later), the cron is suppressed. Correct. But what if `lastResetAt` is from a previous DAY's reset and the cron fires? `60_000ms` is too small to gate that — does the cron correctly fire on the next calendar boundary even after that gate?
- `deleteAllSnapshots` uses SCAN with COUNT=100. For a 1000-member group, 10 SCAN round-trips. Is there a performance concern under load? Any chance of a SCAN missing a concurrently-written key during a round-end?
- `finderBonusSats` is type `number` on the entity (max safe int = 2^53-1 sats ≈ 90M BTC). Cap is 100M sats (1 BTC). What if a clever admin POSTs `Number.MAX_SAFE_INTEGER`? Validation should reject — verify.

### Security
- Admin token check on PATCH `/settings`: is the timing-safe comparison correct? Does `requireAdminToken` constant-time check against the stored hash?
- The PATCH body is destructured per-field; unknown fields are silently ignored. Could a malicious admin smuggle `roundResetPreset='daily'` while leaving validation gates partially passed? Walk the conditional logic.
- `nextResetAt` is computed from `roundResetTimezone` which the admin sets. Could the admin set a TZ that makes `computeNextResetAt` throw or hang? `isValidTimezone` should catch — verify the catch in `cronExprForPreset`/`computeNextResetAt` paths.
- Snapshot keys contain finderAddress (Bitcoin address). Validate that addresses in keys can't escape the Redis key namespace (e.g., `bc1q...:foo` colliding with another key). Are there any code paths where finderAddress comes from untrusted input without normalization?

### Robustness / code quality
- `group-solo.service.ts:writeSnapshot` has a try/catch fallback (`set + expire`) for "some redis variants don't accept options". Is this still needed with node-redis v4 (which the codebase pins)? Or dead code?
- `cronExprForPreset` is a TypeScript switch with no `default` clause — switch is exhaustive over the union but if the entity ever returns a value outside the union (DB has a typo'd preset), the function returns `undefined`. Does that crash gracefully or silently mis-schedule?
- `computeNextResetAt` calls `tempJob.nextDates(intervalDays + 2)`. The cron library starts a setInterval internally on construction even with `start=false`? Verify by reading `node_modules/cron/dist/job.js` or running a memory-leak test for the helper.
- The bonus output is added to `payouts[]` AFTER the fee but BEFORE the kept-miner outputs (sorted by onChain desc). Coinbase output ORDER affects nothing protocol-wise but block-explorer UX might want bonus visually adjacent to the finder's prop output. Is there a documented ordering convention?

### UX / docs
- The UI's "Next reset" preview uses `Intl.DateTimeFormat` with `timeZoneName: 'short'`. On Linux some browsers render "GMT+2" instead of "CEST" — does this confuse users?
- `payout_admin_reset_save_ok_body` says "takes effect from the next calendar boundary" — but for a custom preset starting now, the next fire is "next 00:00 in TZ", which could be < 24h. Is the i18n text accurate for all preset paths?
- The admin can save `preset='daily'` + `intervalDays=25` (UI sends `intervalDays: null` for non-custom, but a hand-crafted curl could send both). Backend validation: does it reject or silently store inconsistent state?

## Output format

For each finding, write:

```
[HIGH/MED/LOW] <one-line summary>
File: path:line
Repro: <minimal description>
Why it matters: <one sentence on impact>
Suggested fix: <one-line direction; full patch optional>
```

End with a one-paragraph overall verdict: ship-as-is / ship-with-followups / DO NOT SHIP. Be honest. The implementer would rather hear "this is broken in case X" than "looks great".

## How to actually do this

You have read access to both repos. Read the files in the order listed (math first, then service, then call sites, then HTTP/UI). For each suspicious code path, trace inputs from the API down to the database write. Where you cannot decide without running the code, say so and propose the experiment.

Don't recap what the code does back to me — assume I read it. Cite specific lines.
