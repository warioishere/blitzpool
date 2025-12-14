# CRITICAL BUG INVESTIGATION: /api/info/rejected Returns All Zeros

## Problem Summary

After deploying PR #100 (commit 5712711) and PR #101 (commit 73d2abb), the `/api/info/rejected` endpoint suddenly returns ALL ZEROS for rejected shares across all time ranges. Previously, this endpoint showed approximately 2M rejected shares per 10-minute slot.

- `/api/info/accepted` WORKS correctly and shows proper accepted share counts
- `/api/info/rejected` shows ALL ZEROS (impossible - miners definitely submit invalid shares)
- System is running in Docker using `docker-compose-mainnet-pm2.yml`
- Multiple PM2 worker processes in cluster mode
- Redis is being used for shared state

## Environment

- Working Directory: `/home/mario/github_repos/blitzpool`
- Current Branch: `fix/incorrect-rollback-stale-delta`
- Main Branch: `blitzpool-master`
- Docker Compose File: `docker-compose-mainnet-pm2.yml`
- Platform: Linux 6.14.0-36-generic

## Recent Commits Context

```
bb52af0 Fix: Incorrect rollback logic using stale delta causing share count inflation
e6b7e68 Merge pull request #101 from warioishere/fix/redis-wrongtype-worker-shares
73d2abb Fix: WRONGTYPE Redis error on worker-shares endpoint
557d2b6 Merge pull request #100 from warioishere/fix/redis-share-count-inflation
5712711 Fix: Critical race condition causing inflated share counts in PM2 cluster mode
```

## Key Files Involved

### Services
- `/home/mario/github_repos/blitzpool/src/ORM/pool-rejected-statistics/pool-rejected-statistics.service.ts`
- `/home/mario/github_repos/blitzpool/src/ORM/pool-share-statistics/pool-share-statistics.service.ts`
- `/home/mario/github_repos/blitzpool/src/models/StratumV1Client.ts` (where `addRejectedShare` is called)

### Database Tables
- `pool_rejected_statistics` - Should contain rejected share records
- `pool_share_statistics` - Contains both accepted and rejected share counts

### Redis Keys
- `pool:rejected:*` - Should store pending rejected share data before flush
- `pool:shares:*` - Stores pending accepted/rejected share data before flush

## Investigation Steps

### 1. Check Redis Keys

Run these commands inside the Redis container:

```bash
# Get into Redis CLI
docker exec -it <redis-container-name> redis-cli

# List all rejected share keys
KEYS pool:rejected:*

# List all share statistics keys
KEYS pool:shares:*

# If you find any pool:rejected:* keys, inspect their data
HGETALL pool:rejected:<timestamp>

# Check if there are any processing locks
KEYS pool:rejected:*:processing
```

**Expected behavior:**
- Should see `pool:rejected:*` keys for current time slots
- Keys should have HASH structure with reasons as fields and counts as values
- Example: `{"duplicate": "123.45", "low-difficulty": "678.90"}`

**Questions to answer:**
- Are `pool:rejected:*` keys being created at all?
- If they exist, do they have data?
- Are they being flushed and deleted too quickly?

### 2. Check Database Tables

Run these SQL queries:

```bash
# Connect to PostgreSQL
docker exec -it <postgres-container-name> psql -U <username> -d <database>

# Check recent rejected share statistics
SELECT time, reason, count, "updatedAt"
FROM pool_rejected_statistics
WHERE time > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000
ORDER BY time DESC
LIMIT 20;

# Check recent pool share statistics (for comparison)
SELECT time, accepted, rejected, "updatedAt"
FROM pool_share_statistics
WHERE time > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000
ORDER BY time DESC
LIMIT 20;

# Count total rejected entries
SELECT COUNT(*), MIN(time), MAX(time)
FROM pool_rejected_statistics;

# Sum of rejected shares in last hour
SELECT SUM(count)
FROM pool_rejected_statistics
WHERE time > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000;
```

**Questions to answer:**
- Are rejected shares making it to the database at all?
- When was the last time a rejected share was recorded?
- Is the `updatedAt` field recent?
- Do the timestamps align with current time?

### 3. Check Application Logs

Search Docker logs for PoolRejectedStatisticsService activity:

```bash
# View recent logs
docker-compose -f docker-compose-mainnet-pm2.yml logs --tail=500 --follow

# Search for rejected statistics service logs
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "PoolRejectedStatisticsService"

# Look for startup messages
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "Using Redis for shared state"

# Look for flush operations
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "flush"

# Look for errors
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "WRONGTYPE"
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "Failed to flush"
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "Failed to claim"

# Look for anomalous diff warnings (should NOT appear if disabled)
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep -i "Anomalous diff"
```

**Questions to answer:**
- Is PoolRejectedStatisticsService initializing correctly?
- Are there any WRONGTYPE errors?
- Is the flush interval running?
- Are there any "Failed to claim key" messages?
- Are there "Anomalous diff" warnings blocking shares?

### 4. Verify Environment Variables

Check if anomalous diff detection is actually disabled:

```bash
# Check environment variables in running containers
docker-compose -f docker-compose-mainnet-pm2.yml exec <service-name> env | grep -i ANOMALOUS

# Or check the docker-compose file
cat docker-compose-mainnet-pm2.yml | grep -i ANOMALOUS
```

**Expected:**
- `ANOMALOUS_DIFF_DETECTION_ENABLED=false` (or '0', 'off', 'no')

**If it's enabled (true):**
- This could be blocking legitimate rejected shares as "anomalous"
- Check logs for "Anomalous diff" warnings

### 5. Check PM2 Worker Status

```bash
# List PM2 processes
docker-compose -f docker-compose-mainnet-pm2.yml exec <service-name> pm2 list

# Check PM2 logs
docker-compose -f docker-compose-mainnet-pm2.yml exec <service-name> pm2 logs --lines 100
```

**Questions to answer:**
- Are all PM2 workers running?
- Are there any crashed workers?
- Are workers restarting frequently?

### 6. Monitor Live Rejected Share Recording

To see if rejected shares are being recorded in real-time:

```bash
# In Redis CLI, monitor commands
docker exec -it <redis-container-name> redis-cli MONITOR

# Or watch for specific keys
watch -n 1 'docker exec <redis-container-name> redis-cli KEYS "pool:rejected:*"'

# Check if shares are being rejected in Stratum logs
docker-compose -f docker-compose-mainnet-pm2.yml logs --follow | grep -i "rejected\|duplicate\|low-difficulty"
```

**Questions to answer:**
- Are rejected shares being submitted by miners?
- Are the `addRejectedShare` calls being made?
- Are Redis HINCRBY commands being executed?
- Are keys being created?

### 7. Code Comparison Analysis

Compare the two services to find differences:

**PoolRejectedStatisticsService (lines 144-211):**
- `addRejectedShare(reason: string, diff: number): Promise<boolean>`
- Has anomaly detection logic (lines 150-175)
- Returns `false` if share is rejected as anomalous (line 166)
- Uses `pool:rejected:${timeSlot}` Redis keys (line 179)
- Uses `hIncrByFloat(key, reason, diff)` to increment per-reason counts (line 182)

**PoolShareStatisticsService (lines 256-262):**
- `addRejectedShare(difficulty: number)`
- No anomaly detection
- Uses `pool:shares:${timeSlot}` Redis keys (line 86)
- Uses `hIncrByFloat(key, 'rejected', rejected)` to increment total rejected count (line 93)

**Critical Difference:**
- PoolRejectedStatisticsService has anomaly detection that returns `false`
- If anomaly detection is enabled, legitimate shares might be blocked
- Check if `ANOMALOUS_DIFF_DETECTION_ENABLED` is set correctly

### 8. Check Stratum Client Code

Look at where rejected shares are recorded in `/home/mario/github_repos/blitzpool/src/models/StratumV1Client.ts`:

```typescript
// Around lines 825-837 (multiple occurrences)
const accepted = await this.poolRejectedStatisticsService.addRejectedShare(
  reason,
  this.sessionDifficulty,
);
if (accepted) {
  await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
}
await this.clientRejectedStatisticsService.addRejectedShare(
  this.address,
  reason,
  this.sessionDifficulty,
);
```

**Critical Logic:**
- If `poolRejectedStatisticsService.addRejectedShare()` returns `false`, the share is NOT recorded in `poolShareStatisticsService`
- But it IS still recorded in `clientRejectedStatisticsService`
- This could explain why `/api/info/rejected` shows zeros but individual client stats might still work

### 9. Trace the Bug Timeline

**Before PR #100:**
- Both services might have had simpler logic
- Rejected shares were recorded correctly

**After PR #100 (commit 5712711):**
- Added atomic claim-and-fetch with Lua scripts
- Added distributed locking with processing keys
- Added key filtering to avoid WRONGTYPE errors
- Changed startup cleanup to flush before deleting

**After PR #101 (commit 73d2abb):**
- Added filtering for `:processing`, `:hydrated`, `:lock` keys
- Fixed WRONGTYPE errors by excluding metadata keys

**Current (commit bb52af0):**
- Fixed rollback logic in ShareTotalsCacheService
- Uses `flushedDelta` instead of stale `delta`

**Question:**
- Did any of these changes break the rejected share recording?

## Hypotheses to Test

### Hypothesis 1: Anomaly Detection Blocking All Shares
**Evidence needed:**
- Check if `ANOMALOUS_DIFF_DETECTION_ENABLED=true`
- Look for "Anomalous diff" warnings in logs
- If found, this is the bug

**Fix:**
- Set `ANOMALOUS_DIFF_DETECTION_ENABLED=false` in environment
- OR fix the anomaly detection logic to not block legitimate shares

### Hypothesis 2: Redis Keys Being Created but Not Flushed
**Evidence needed:**
- `pool:rejected:*` keys exist in Redis
- Keys have data (HGETALL shows counts)
- But database table is empty or outdated

**Possible causes:**
- Flush interval not running
- Lua script failing silently
- Processing locks not being cleaned up
- WRONGTYPE errors during flush

**Fix:**
- Debug the `saveCurrent()` method
- Check for errors in flush logs
- Verify Lua script is working

### Hypothesis 3: Redis Keys Not Being Created At All
**Evidence needed:**
- No `pool:rejected:*` keys in Redis
- Miners ARE submitting invalid shares (check Stratum logs)
- `addRejectedShare` is being called (add debug logging)

**Possible causes:**
- Redis connection failure
- Silent exception in `addRejectedShare`
- Logic error preventing key creation

**Fix:**
- Add detailed logging to `addRejectedShare`
- Verify Redis connection
- Check for exceptions

### Hypothesis 4: Key Filtering Too Aggressive
**Evidence needed:**
- `pool:rejected:*` keys are being filtered out during flush
- Check if the filter pattern is excluding valid keys

**Code to review:**
```typescript
// Line 223 in pool-rejected-statistics.service.ts
const dataKeys = allKeys.filter(key => !key.endsWith(':processing'));
```

**Question:**
- Are there other metadata suffixes being used?
- Is the filter correct?

### Hypothesis 5: Lua Script Returns Empty Result
**Evidence needed:**
- Lua script is executing
- But returning `nil` or empty array
- Check if multiple workers are claiming the same key

**Code to review:**
```typescript
// Lines 228-239 in pool-rejected-statistics.service.ts
const claimScript = `
  local key = KEYS[1]
  local lockKey = key .. ':processing'
  local acquired = redis.call('SET', lockKey, '1', 'NX', 'EX', 10)
  if acquired then
    local data = redis.call('HGETALL', key)
    redis.call('DEL', key)
    return data
  else
    return nil
  end
`;
```

**Question:**
- Is the lock expiry (10 seconds) too short?
- Are all workers failing to acquire locks?

## Expected Diagnosis Format

Once investigation is complete, provide:

### 1. WHERE rejected shares are being lost
- Redis? (keys not created)
- Flush? (keys created but not flushed)
- Database? (flush runs but data not persisted)
- Blocked? (anomaly detection rejecting shares)

### 2. WHY it started after PR #100/#101
- What specific change caused the regression?
- Was it the Lua script?
- The key filtering?
- The processing locks?
- Environment variable?

### 3. The EXACT line of code causing the issue
- File path (absolute)
- Line number
- Code snippet
- Explanation of why it's wrong

### 4. Proposed fix
- Specific code change
- Why this fixes it
- Any side effects
- Testing strategy

## Additional Notes

- The anomaly detection feature in PoolRejectedStatisticsService is suspicious
- It's the main difference between the two services
- If enabled, it could block all shares as "anomalous"
- The logic checks if `diff > avg * 4` and returns `false` (line 166)
- This prevents the share from being recorded in PoolShareStatisticsService
- But the share IS still recorded in ClientRejectedStatisticsService
- This matches the symptom: `/api/info/rejected` shows zeros but client stats might work

**FIRST THING TO CHECK:**
```bash
# Check this immediately
docker-compose -f docker-compose-mainnet-pm2.yml exec <service-name> env | grep ANOMALOUS_DIFF_DETECTION_ENABLED

# And search logs for
docker-compose -f docker-compose-mainnet-pm2.yml logs | grep "Anomalous diff"
```

If you see "Anomalous diff" warnings, **THAT'S THE BUG**.

## Commands Reference

### Docker Commands
```bash
# List containers
docker-compose -f docker-compose-mainnet-pm2.yml ps

# View logs
docker-compose -f docker-compose-mainnet-pm2.yml logs --tail=500

# Execute command in container
docker-compose -f docker-compose-mainnet-pm2.yml exec <service> <command>

# Restart service
docker-compose -f docker-compose-mainnet-pm2.yml restart <service>
```

### Redis Commands
```bash
# Connect to Redis
docker exec -it <redis-container> redis-cli

# List keys
KEYS pool:rejected:*
KEYS pool:shares:*

# Get hash data
HGETALL pool:rejected:1234567890

# Monitor all commands
MONITOR

# Get key type
TYPE pool:rejected:1234567890
```

### PostgreSQL Commands
```bash
# Connect to PostgreSQL
docker exec -it <postgres-container> psql -U <username> -d <database>

# List tables
\dt

# Describe table
\d pool_rejected_statistics

# Query data
SELECT * FROM pool_rejected_statistics LIMIT 10;
```

Good luck with the investigation!
