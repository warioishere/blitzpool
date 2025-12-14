# Time Slot Endpoints Review & Fix Instructions

## Current Status

✅ **FIXED in PR #103:**
- `GET /info/chart` (pool-level hashrate chart)
- `GET /client/:address/chart` (address-level hashrate chart)
- `GET /client/:address/worker/:name/chart` (worker-level hashrate chart)
- `GET /client/:address/worker/:name/session/:id/chart` (session-level hashrate chart)

## Endpoints That ALSO Need Fixing

The following endpoints use 10-minute time slots but still have **start-time labeling** and include the **incomplete current slot**:

### 1. Pool-Level Statistics Endpoints

#### `GET /info/accepted`
- **File:** `src/app.controller.ts:336-372`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Code location:**
  ```typescript
  const coeff = 1000 * 60 * 10;
  const startSlot = Math.floor(sinceTime / coeff) * coeff;
  const endSlot = Math.floor(now / coeff) * coeff;  // ← Current slot (incomplete!)
  for (let t = startSlot; t <= endSlot; t += coeff) {  // ← Includes incomplete slot
    slotData.push({
      time: new Date(t).toISOString(),  // ← Start-time label
      counts: { accepted: slotMap.get(t) || 0 },
    });
  }
  ```

#### `GET /info/workers`
- **File:** `src/app.controller.ts:374-428`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Special case:** Lines 419-423 override the last slot with live data from `getActiveWorkerCounts()` - this is a hack that should be removed
- **Code location:**
  ```typescript
  const currentSlot = Math.floor(now / coeff) * coeff;
  if (endSlot === currentSlot && slotData.length > 0) {
    const liveCounts = await this.clientService.getActiveWorkerCounts();
    slotData[slotData.length - 1].counts = liveCounts;  // ← Hack!
  }
  ```

#### `GET /info/rejected`
- **File:** `src/app.controller.ts:430-473`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Code location:**
  ```typescript
  const coeff = 1000 * 60 * 10;
  const startSlot = Math.floor(sinceTime / coeff) * coeff;
  const endSlot = Math.floor(now / coeff) * coeff;  // ← Current slot (incomplete!)
  for (let t = startSlot; t <= endSlot; t += coeff) {  // ← Includes incomplete slot
    const counts: Record<string, number> = {};
    for (const reason of allReasons) {
      counts[reason] = slotMap.get(t)?.[reason] || 0;
    }
    slotData.push({ time: new Date(t).toISOString(), counts });  // ← Start-time label
  }
  ```

### 2. Address-Level Statistics Endpoints

#### `GET /client/:address/workers`
- **File:** `src/controllers/client/client.controller.ts:92-118`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Code location:**
  ```typescript
  const coeff = 1000 * 60 * 10;
  const startSlot = Math.floor(sinceTime / coeff) * coeff;
  const endSlot = Math.floor(now / coeff) * coeff;  // ← Current slot (incomplete!)
  for (let t = startSlot; t <= endSlot; t += coeff) {  // ← Includes incomplete slot
    const counts = slotMap.get(t) || { workers: 0, sessions: 0 };
    slotData.push({ time: new Date(t).toISOString(), counts });  // ← Start-time label
  }
  ```

#### `GET /client/:address/accepted`
- **File:** `src/controllers/client/client.controller.ts:120-145`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Code location:**
  ```typescript
  const coeff = 1000 * 60 * 10;
  const startSlot = Math.floor(sinceTime / coeff) * coeff;
  const endSlot = Math.floor(now / coeff) * coeff;  // ← Current slot (incomplete!)
  for (let t = startSlot; t <= endSlot; t += coeff) {  // ← Includes incomplete slot
    slotData.push({
      time: new Date(t).toISOString(),  // ← Start-time label
      counts: { accepted: slotMap.get(t) || 0 }
    });
  }
  ```

#### `GET /client/:address/rejected`
- **File:** `src/controllers/client/client.controller.ts:147-182`
- **Issue:** Uses start-time slots, includes current incomplete slot
- **Code location:**
  ```typescript
  const coeff = 1000 * 60 * 10;
  const startSlot = Math.floor(sinceTime / coeff) * coeff;
  const endSlot = Math.floor(now / coeff) * coeff;  // ← Current slot (incomplete!)
  for (let t = startSlot; t <= endSlot; t += coeff) {  // ← Includes incomplete slot
    const counts: Record<string, { count: number; diffMinusOne: number }> = {};
    for (const reason of allReasons) {
      const current = slotMap.get(t)?.[reason] || { count: 0, diffMinusOne: 0 };
      counts[reason] = current;
    }
    slotData.push({ time: new Date(t).toISOString(), counts });  // ← Start-time label
  }
  ```

---

## How These Endpoints Get Their Data

### Client Statistics (already migrated ✅)
- **Table:** `client_statistics_entity`
- **Time slots created in:** `src/models/StratumV1ClientStatistics.ts`
- **Migration status:** ✅ Already updated to end-time in PR #103
- **Time values:** All have 10 minutes added by migration

### Pool Share Statistics (needs migration ⚠️)
- **Table:** `pool_share_statistics_entity`
- **Time slots created in:** `src/ORM/pool-share-statistics/pool-share-statistics.service.ts:70-73`
- **Migration status:** ❌ Still using start-time
- **Current code:**
  ```typescript
  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10;
    return Math.floor(Date.now() / coeff) * coeff;  // ← Start-time!
  }
  ```
- **What needs to change:**
  ```typescript
  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10;
    return Math.floor(Date.now() / coeff) * coeff + coeff;  // ← End-time!
  }
  ```

### Pool Rejected Statistics (needs migration ⚠️)
- **Table:** `pool_rejected_statistics_entity`
- **Time slots:** Needs investigation - likely similar to pool share statistics
- **Migration status:** ❌ Needs review and update

### Client Rejected Statistics (needs migration ⚠️)
- **Table:** `client_rejected_statistics_entity`
- **Time slots:** Needs investigation
- **Migration status:** ❌ Needs review and update

---

## Fix Instructions (For Tomorrow)

### Step 1: Update Migration Service

**File:** `src/services/timeslot-migration.service.ts`

Add migrations for the additional tables:

```typescript
// After migrating client_statistics_entity, also migrate:

// 1. Pool share statistics
await queryRunner.query(`
  UPDATE pool_share_statistics_entity
  SET time = time + ?
`, [this.TIME_SLOT_DURATION_MS]);

// 2. Pool rejected statistics
await queryRunner.query(`
  UPDATE pool_rejected_statistics_entity
  SET time = time + ?
`, [this.TIME_SLOT_DURATION_MS]);

// 3. Client rejected statistics
await queryRunner.query(`
  UPDATE client_rejected_statistics_entity
  SET time = time + ?
`, [this.TIME_SLOT_DURATION_MS]);
```

Update the migration key to indicate all tables are migrated:
```typescript
private readonly MIGRATION_KEY = 'TIMESLOT_END_TIME_MIGRATION_V2_COMPLETED';
```

### Step 2: Update Time Slot Generation

#### A. Pool Share Statistics
**File:** `src/ORM/pool-share-statistics/pool-share-statistics.service.ts:70-73`

```typescript
// Current:
private getTimeSlot(): number {
  const coeff = 1000 * 60 * 10;
  return Math.floor(Date.now() / coeff) * coeff;
}

// Change to:
private getTimeSlot(): number {
  const coeff = 1000 * 60 * 10;
  // Time slot labeled by END time (e.g., slot "20:50" contains data from 20:40-20:50)
  return Math.floor(Date.now() / coeff) * coeff + coeff;
}
```

#### B. Pool Rejected Statistics
Find where time slots are created (similar to pool share statistics) and apply same fix.

#### C. Client Rejected Statistics
Find where time slots are created and apply same fix.

### Step 3: Update Display Logic in Endpoints

For each endpoint listed above, apply this pattern:

**Current pattern:**
```typescript
const coeff = 1000 * 60 * 10;
const startSlot = Math.floor(sinceTime / coeff) * coeff;
const endSlot = Math.floor(now / coeff) * coeff;
for (let t = startSlot; t <= endSlot; t += coeff) {
  slotData.push({ time: new Date(t).toISOString(), counts });
}
```

**New pattern:**
```typescript
const coeff = 1000 * 60 * 10;
const currentSlot = Math.floor(now / coeff) * coeff + coeff; // Current incomplete slot (end-time labeled)
const startSlot = Math.floor(sinceTime / coeff) * coeff + coeff; // First complete slot
const endSlot = currentSlot - coeff; // Last complete slot (exclude current)
for (let t = startSlot; t <= endSlot; t += coeff) {
  slotData.push({ time: new Date(t).toISOString(), counts: slotMap.get(t) || {...} });
}
```

**Alternative (simpler) pattern:**
```typescript
const coeff = 1000 * 60 * 10;
const currentSlot = Math.floor(now / coeff) * coeff + coeff;
const startSlot = Math.floor(sinceTime / coeff) * coeff + coeff;
for (let t = startSlot; t < currentSlot; t += coeff) {  // Note: t < currentSlot (not <=)
  slotData.push({ time: new Date(t).toISOString(), counts: slotMap.get(t) || {...} });
}
```

### Step 4: Remove Hacks

#### `/info/workers` special case
**File:** `src/app.controller.ts:419-423`

**Remove this code:**
```typescript
const currentSlot = Math.floor(now / coeff) * coeff;
if (endSlot === currentSlot && slotData.length > 0) {
  const liveCounts = await this.clientService.getActiveWorkerCounts();
  slotData[slotData.length - 1].counts = liveCounts;
}
```

This is no longer needed because we won't be including the incomplete current slot.

---

## Files to Modify

### Core Changes:
1. ✅ `src/services/timeslot-migration.service.ts` - Add pool/rejected statistics migrations
2. ⚠️ `src/ORM/pool-share-statistics/pool-share-statistics.service.ts` - Update getTimeSlot()
3. ⚠️ Find and update pool rejected statistics time slot generation
4. ⚠️ Find and update client rejected statistics time slot generation

### Endpoint Display Logic:
5. ⚠️ `src/app.controller.ts` - Fix `/info/accepted`, `/info/workers`, `/info/rejected`
6. ⚠️ `src/controllers/client/client.controller.ts` - Fix `/client/:address/workers`, `/client/:address/accepted`, `/client/:address/rejected`

---

## Testing Checklist

After applying fixes:

- [ ] Migration runs successfully and updates all 4 tables
- [ ] Pool share statistics use end-time labeling
- [ ] Pool rejected statistics use end-time labeling
- [ ] Client rejected statistics use end-time labeling
- [ ] `/info/accepted` excludes current incomplete slot
- [ ] `/info/workers` excludes current incomplete slot (and live count hack removed)
- [ ] `/info/rejected` excludes current incomplete slot
- [ ] `/client/:address/workers` excludes current incomplete slot
- [ ] `/client/:address/accepted` excludes current incomplete slot
- [ ] `/client/:address/rejected` excludes current incomplete slot
- [ ] All endpoints show data with ~5-10 min lag (not 15-20 min)
- [ ] No errors in logs

---

## Impact Estimate

**Database migration:**
- 4 tables to update (client_statistics, pool_share_statistics, pool_rejected_statistics, client_rejected_statistics)
- Expected time: < 10 seconds for most pools
- Migration is idempotent and safe

**Load impact:**
- Same as PR #103 (6x more chart queries)
- No additional impact from these changes

**User experience:**
- All time-series endpoints will be consistent
- All will show data with ~5-10 min lag instead of 15-20 min
- More intuitive labeling across the board

---

## Questions to Investigate Tomorrow

1. ✅ Where is `pool_rejected_statistics_entity.time` set?
   - Search for: `poolRejectedStatisticsService` or similar
   - Find the time slot creation logic

2. ✅ Where is `client_rejected_statistics_entity.time` set?
   - Search for: `clientRejectedStatisticsService` or similar
   - Find the time slot creation logic

3. ⚠️ Are there any other tables with `time` columns that use 10-minute slots?
   - Run: `grep -r "1000 * 60 * 10" src/` to find all 10-minute slot calculations

4. ⚠️ Do we need to update any aggregation services?
   - Check: `src/services/aggregation.service.ts` - may need updates if it pre-computes these endpoints

---

## Quick Reference: The Fix Pattern

**For time slot creation (where data is written):**
```typescript
// Change:
const timeSlot = Math.floor(Date.now() / coeff) * coeff;
// To:
const timeSlot = Math.floor(Date.now() / coeff) * coeff + coeff;
```

**For endpoint display (where data is read):**
```typescript
// Change:
const endSlot = Math.floor(now / coeff) * coeff;
for (let t = startSlot; t <= endSlot; t += coeff) { ... }
// To:
const currentSlot = Math.floor(now / coeff) * coeff + coeff;
for (let t = startSlot; t < currentSlot; t += coeff) { ... }
```

**For database migration:**
```sql
UPDATE <table_name> SET time = time + 600000;  -- Add 10 minutes
```

---

## Notes

- All these endpoints follow the same pattern, so the fix is repetitive but straightforward
- The migration service already handles transactions and rollback
- Consider doing this in a separate PR or adding to PR #103 before merging
- User tokens are low, so this document is self-contained for tomorrow's work
