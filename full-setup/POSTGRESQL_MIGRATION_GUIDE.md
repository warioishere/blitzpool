# BlitzPool PostgreSQL Migration Guide

## Overview

This guide walks you through migrating your BlitzPool mining pool from SQLite to PostgreSQL. The migration is designed to be **safe, reversible, and with minimal downtime** (estimated 10-20 minutes).

---

## Why Migrate to PostgreSQL?

### Current SQLite Limitations
- ❌ **Single-writer architecture** - Only ONE write transaction at a time (even in WAL mode)
- ❌ **SQLITE_BUSY errors** - Lock contention with 818 active addresses, ~400 writes every 30 seconds
- ❌ **Limited scalability** - Won't scale beyond ~2,000 active addresses

### PostgreSQL Benefits
- ✅ **True concurrent writes** - Multiple transactions simultaneously
- ✅ **Scales to 10,000+ addresses** - Production-grade database
- ✅ **Better tooling** - pgAdmin, pg_stat_statements, excellent monitoring
- ✅ **No more SQLITE_BUSY errors** - Proper multi-writer support
- ✅ **Your bulk UPDATE fix works on both!** - Already implemented

---

## What Was Fixed

### Critical Bug Fixes Applied

1. **`src/ORM/address-settings/address-settings.service.ts`**
   - Fixed `addSharesBulk()` to use PostgreSQL placeholders (`$1, $2`) instead of SQLite placeholders (`?`)
   - Production-critical: This method is called ~400 times every 30 seconds

2. **`src/services/timeslot-migration.service.ts`**
   - Fixed database placeholder compatibility for time slot migrations
   - Updated CREATE TABLE statements for PostgreSQL compatibility

**Status:** ✅ All critical bugs fixed - code is now PostgreSQL-ready!

---

## Pre-Migration Checklist

### 1. Verify Current State

```bash
# Check current SQLite database size
ls -lh /home/blitzpool/public-pool/full-setup/data/mainnet/public-pool/public-pool.sqlite

# Check number of addresses
sqlite3 /home/blitzpool/public-pool/full-setup/data/mainnet/public-pool/public-pool.sqlite \
  "SELECT COUNT(*) FROM address_settings_entity;"

# Expected: 818 addresses (or similar)
```

### 2. Backup SQLite Database

**CRITICAL:** Always backup before migration!

```bash
# Create backup directory
mkdir -p /home/blitzpool/public-pool/backups

# Backup with timestamp
cp /home/blitzpool/public-pool/full-setup/data/mainnet/public-pool/public-pool.sqlite \
   /home/blitzpool/public-pool/backups/public-pool-$(date +%Y%m%d-%H%M%S).sqlite

# Verify backup
ls -lh /home/blitzpool/public-pool/backups/
```

### 3. Stop Current Pool (If Running)

```bash
cd /home/blitzpool/public-pool/full-setup

# Stop the current stack
docker-compose down

# Verify containers are stopped
docker ps | grep -E "public-pool|bitcoin|redis|postgres"
```

### 4. Review Configuration Files

**Files Modified for PostgreSQL:**
- ✅ `blitzpool-pg.env` - New PostgreSQL configuration
- ✅ `docker-compose-mainnet-pg-pm2.yml` - Updated to use blitzpool-pg.env
- ✅ Source code fixes applied (addSharesBulk, timeslot-migration)

**Review the configuration:**
```bash
cd /home/blitzpool/public-pool/full-setup

# Check PostgreSQL environment file
cat blitzpool-pg.env | grep -A 10 "DATABASE CONFIGURATION"

# Verify docker-compose uses correct env file
grep "blitzpool-pg.env" docker-compose-mainnet-pg-pm2.yml
```

---

## Migration Process

### Step 1: Build Updated Code

First, rebuild the Docker image with the PostgreSQL fixes:

```bash
cd /home/blitzpool/public-pool

# Build the updated image
docker build -f Dockerfile_pm2 -t blitzpool-pm2:latest .

# Verify build succeeded
docker images | grep blitzpool-pm2
```

### Step 2: Start PostgreSQL and Dependencies

```bash
cd /home/blitzpool/public-pool/full-setup

# Start PostgreSQL and Redis (but not the pool yet)
docker-compose -f docker-compose-mainnet-pg-pm2.yml up -d postgres redis bitcoin

# Wait for PostgreSQL to be ready (about 10-15 seconds)
docker-compose -f docker-compose-mainnet-pg-pm2.yml logs -f postgres

# Look for: "database system is ready to accept connections"
# Press Ctrl+C when you see this message
```

### Step 3: Verify PostgreSQL Health

```bash
# Check PostgreSQL is running
docker exec -it public-pool-postgres pg_isready -U postgres

# Expected: "postgres:5432 - accepting connections"

# Test database connection
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "SELECT version();"

# Expected: PostgreSQL version information
```

### Step 4: Start BlitzPool with Automatic Migration

The pool will **automatically migrate** SQLite data to PostgreSQL on first startup:

```bash
cd /home/blitzpool/public-pool/full-setup

# Start the pool (this will trigger automatic migration)
docker-compose -f docker-compose-mainnet-pg-pm2.yml up -d public-pool

# Monitor migration logs in real-time
docker logs -f public-pool
```

**What to Expect in Logs:**

```
[Migration] Starting migration from SQLite to Postgres using batch size 500...
[address_settings_entity] Migrating 818 rows...
[address_settings_entity] Processed 818/818 rows.
[client_statistics_entity] Migrating 125000 rows...
[client_statistics_entity] Processed 50000/125000 rows.
[client_statistics_entity] Processed 100000/125000 rows.
[client_statistics_entity] Processed 125000/125000 rows.
...
[Migration] Migration finished.
[ShareTotalsCacheService] Using Redis for shared cache across PM2 workers
[StatisticsBatchService] Statistics batch writer started (flush every 300s)
[StratumV1Service] Stratum server listening on port 3333
```

**Migration Duration:** 5-20 minutes depending on historical data size

### Step 5: Verify Migration Success

While migration is running or after completion:

```bash
# Check PostgreSQL table row counts
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT
    'address_settings_entity' AS table_name, COUNT(*) AS rows FROM address_settings_entity
  UNION ALL
  SELECT 'client_statistics_entity', COUNT(*) FROM client_statistics_entity
  UNION ALL
  SELECT 'blocks_entity', COUNT(*) FROM blocks_entity;
"

# Expected output should match SQLite counts
# Example:
#       table_name          | rows
# -------------------------+--------
# address_settings_entity  |    818
# client_statistics_entity | 125000
# blocks_entity           |      5
```

**Verify Share Totals:**

```bash
# Top 10 addresses by share count
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT address, shares, \"bestDifficulty\"
  FROM address_settings_entity
  ORDER BY shares DESC
  LIMIT 10;
"

# Compare with SQLite backup
sqlite3 /home/blitzpool/public-pool/backups/public-pool-*.sqlite \
  "SELECT address, shares, bestDifficulty FROM address_settings_entity ORDER BY shares DESC LIMIT 10;"

# Numbers should match EXACTLY
```

---

## Post-Migration Validation

### 1. Monitor Share Processing

```bash
# Watch share processing logs
docker logs -f public-pool | grep -E "share|Flushed|UPDATE"

# Look for:
# - "ShareTotalsCacheService: Flushed [N] inserts, [N] updates"
# - Bulk UPDATE should complete in < 100ms (faster than SQLite's ~80ms!)
# - No SQL errors
```

### 2. Test Bulk UPDATE Performance

The critical `addSharesBulk()` method should now work flawlessly:

```bash
# Watch for bulk UPDATE operations
docker logs -f public-pool | grep "Flushed"

# Example expected output:
# ShareTotalsCacheService: Flushed 400 inserts, 0 updates
# [Time: 65ms] ← Should be < 100ms, often faster than SQLite!
```

### 3. Check for Errors

```bash
# Search for SQL errors (should be empty)
docker logs public-pool | grep -i "error" | grep -i "sql"

# Search for SQLITE_BUSY errors (should be GONE!)
docker logs public-pool | grep "SQLITE_BUSY"
# Expected: NO OUTPUT (problem solved!)

# Search for PostgreSQL connection issues
docker logs public-pool | grep -i "postgres.*error"
# Expected: NO OUTPUT
```

### 4. Verify API Endpoints

```bash
# Test pool info endpoint
curl http://localhost:3334/api/pool/info | jq

# Test statistics endpoint
curl http://localhost:3334/api/pool/statistics | jq

# Test specific address (replace with real address)
curl http://localhost:3334/api/address/YOUR_BITCOIN_ADDRESS/info | jq

# All should return valid JSON with correct data
```

### 5. Monitor Connection Pool

```bash
# Check PostgreSQL connections
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT
    count(*) AS active_connections,
    state
  FROM pg_stat_activity
  WHERE datname = 'public_pool'
  GROUP BY state;
"

# Expected: ~23 connections per PM2 instance × 4 instances = ~92 connections
# Should be well below max_connections (100)
```

### 6. Test Miner Connectivity

```bash
# Submit test share from miner
# Watch logs to ensure share is recorded in PostgreSQL
docker logs -f public-pool | grep "share submitted"

# Verify share was written to database
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT COUNT(*) FROM address_settings_entity WHERE shares > 0;
"
```

---

## Performance Monitoring (First 24 Hours)

### Key Metrics to Watch

#### 1. **Bulk UPDATE Performance**
```bash
# Monitor share flush timing
docker logs -f public-pool | grep "ShareTotalsCacheService"

# Target: < 100ms for 800 addresses
# PostgreSQL often FASTER than SQLite due to better query planner
```

#### 2. **Database Query Performance**
```bash
# Enable pg_stat_statements (if not already enabled)
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
"

# Top 10 slowest queries
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT
    substring(query, 1, 60) AS query_snippet,
    calls,
    round(total_exec_time::numeric, 2) AS total_time_ms,
    round(mean_exec_time::numeric, 2) AS avg_time_ms,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS percent
  FROM pg_stat_statements
  WHERE query NOT LIKE '%pg_stat_statements%'
  ORDER BY total_exec_time DESC
  LIMIT 10;
"
```

#### 3. **Connection Pool Health**
```bash
# Monitor connection pool usage
watch -n 5 'docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT state, count(*)
  FROM pg_stat_activity
  WHERE datname = '\''public_pool'\''
  GROUP BY state;
"'

# Watch for "idle in transaction" (should be minimal)
# Active connections should fluctuate based on workload
```

#### 4. **Redis Cache Hit Rate**
```bash
# Check Redis memory usage and key count
docker exec -it public-pool-redis redis-cli info stats | grep -E "keyspace_hits|keyspace_misses"

# Calculate hit rate:
# hit_rate = keyspace_hits / (keyspace_hits + keyspace_misses) × 100%
# Target: > 80% hit rate
```

#### 5. **Disk I/O**
```bash
# Monitor PostgreSQL disk writes
watch -n 5 'docker stats public-pool-postgres --no-stream | tail -1'

# Watch for:
# - MEM USAGE: Should stay under 512MB for small pools
# - BLOCK I/O: Should be low and consistent
```

---

## Rollback Plan (If Needed)

If something goes wrong, you can rollback to SQLite:

### Option 1: Quick Rollback (Recommended if migration fails early)

```bash
cd /home/blitzpool/public-pool/full-setup

# Stop everything
docker-compose -f docker-compose-mainnet-pg-pm2.yml down

# Switch back to original configuration
# Edit docker-compose to use blitzpool.env (SQLite config)
# OR use a different docker-compose file for SQLite

# Restore SQLite database from backup (if needed)
cp /home/blitzpool/public-pool/backups/public-pool-*.sqlite \
   ./data/mainnet/public-pool/public-pool.sqlite

# Start with SQLite
# (Use your original docker-compose configuration)
docker-compose up -d
```

### Option 2: Export PostgreSQL Data Back to SQLite

If PostgreSQL ran for a while and you need to preserve new data:

```bash
# This is more complex - contact support or:
# 1. Export PostgreSQL data to SQL dump
docker exec -it public-pool-postgres pg_dump -U postgres -d public_pool > pg_backup.sql

# 2. Write custom script to import into SQLite
# (This requires manual work - PostgreSQL SQL is not compatible with SQLite)
```

**Recommendation:** Keep SQLite database intact for 1 week after successful PostgreSQL migration as insurance.

---

## PostgreSQL Maintenance

### Daily Tasks (Automated)

PostgreSQL has **autovacuum** enabled by default - no manual intervention needed for daily maintenance.

### Weekly Tasks (Recommended)

```bash
# Check database size
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT pg_size_pretty(pg_database_size('public_pool'));
"

# Check table sizes
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

### Monthly Tasks (Optional)

```bash
# Manual VACUUM ANALYZE (if autovacuum is not keeping up)
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  VACUUM ANALYZE;
"

# Reindex (if query performance degrades)
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  REINDEX DATABASE public_pool;
"
```

### Backup Strategy

```bash
# Daily automated backup (add to cron)
docker exec -t public-pool-postgres pg_dump -U postgres -d public_pool | \
  gzip > /home/blitzpool/backups/public-pool-pg-$(date +%Y%m%d).sql.gz

# Example cron entry (daily at 3 AM):
# 0 3 * * * docker exec -t public-pool-postgres pg_dump -U postgres -d public_pool | gzip > /home/blitzpool/backups/public-pool-pg-$(date +\%Y\%m\%d).sql.gz
```

---

## Troubleshooting

### Issue: Migration Fails with "relation already exists"

**Cause:** PostgreSQL database has leftover data from previous migration attempt

**Solution:**
```bash
# Drop and recreate database
docker exec -it public-pool-postgres psql -U postgres -c "DROP DATABASE IF EXISTS public_pool;"
docker exec -it public-pool-postgres psql -U postgres -c "CREATE DATABASE public_pool;"

# Restart pool to retry migration
docker-compose -f docker-compose-mainnet-pg-pm2.yml restart public-pool
```

### Issue: "Too many connections" error

**Cause:** Connection pool size × PM2 instances > PostgreSQL max_connections

**Solution:**
```bash
# Check current connections
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT count(*) FROM pg_stat_activity;
"

# If > 90 connections, reduce pool size in blitzpool-pg.env:
# PG_POOL_SIZE=15  (down from 23)

# Restart pool
docker-compose -f docker-compose-mainnet-pg-pm2.yml restart public-pool
```

### Issue: Slow query performance

**Cause:** Missing indexes or unoptimized queries

**Solution:**
```bash
# Find slow queries
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT
    substring(query, 1, 100) AS query,
    calls,
    round(mean_exec_time::numeric, 2) AS avg_ms
  FROM pg_stat_statements
  WHERE mean_exec_time > 100  -- Queries slower than 100ms
  ORDER BY mean_exec_time DESC
  LIMIT 10;
"

# Analyze tables
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  ANALYZE;
"
```

### Issue: "SQLITE_BUSY" errors persist

**Cause:** Code is still using SQLite instead of PostgreSQL

**Solution:**
```bash
# Verify DB_TYPE is set correctly
docker exec -it public-pool env | grep DB_TYPE
# Expected: DB_TYPE=postgres

# Check logs for database type detection
docker logs public-pool | grep "database type"

# If using SQLite, check environment variable overrides in docker-compose
```

### Issue: Data doesn't match between SQLite and PostgreSQL

**Cause:** Data was modified during migration or migration was incomplete

**Solution:**
```bash
# Re-run migration with fresh PostgreSQL database
docker-compose -f docker-compose-mainnet-pg-pm2.yml down
docker exec -it public-pool-postgres psql -U postgres -c "DROP DATABASE public_pool; CREATE DATABASE public_pool;"
docker-compose -f docker-compose-mainnet-pg-pm2.yml up -d

# Or restore from SQLite backup and retry
```

---

## Success Criteria Checklist

Migration is successful when ALL of these are true:

- [ ] **Database Migration**
  - [ ] Row counts match between SQLite and PostgreSQL
  - [ ] Share totals are identical
  - [ ] Top 10 addresses by shares match

- [ ] **Application Health**
  - [ ] No SQL syntax errors in logs
  - [ ] No "SQLITE_BUSY" errors (problem solved!)
  - [ ] No PostgreSQL connection errors
  - [ ] API endpoints return correct data
  - [ ] Stratum server accepts connections

- [ ] **Performance**
  - [ ] Bulk UPDATE completes in < 100ms
  - [ ] ShareTotalsCacheService flushes successfully
  - [ ] StatisticsBatchService flushes successfully
  - [ ] Connection pool stays below max_connections
  - [ ] No query timeouts

- [ ] **24 Hour Stability**
  - [ ] No crashes or restarts
  - [ ] Share processing continuous
  - [ ] Miners remain connected
  - [ ] Data accuracy maintained

---

## Next Steps After Successful Migration

### 1. Clean Up Old SQLite Database (After 1 Week)

```bash
# After 1 week of stable PostgreSQL operation:
mv /home/blitzpool/public-pool/full-setup/data/mainnet/public-pool/public-pool.sqlite \
   /home/blitzpool/backups/public-pool-final-sqlite-$(date +%Y%m%d).sqlite

# Keep the backup indefinitely as historical archive
```

### 2. Optimize PostgreSQL Configuration

Based on your workload, tune PostgreSQL further:

```bash
# Edit PostgreSQL config (requires restart)
docker exec -it public-pool-postgres vi /var/lib/postgresql/data/postgresql.conf

# Key settings to tune:
# - shared_buffers (25% of RAM)
# - effective_cache_size (50-75% of RAM)
# - work_mem (adjust based on query complexity)
# - max_connections (based on actual usage)
```

### 3. Set Up Monitoring

Consider adding:
- **Prometheus + Grafana** for metrics visualization
- **pgAdmin** for PostgreSQL management GUI
- **Automated backups** to external storage
- **Alert rules** for connection pool exhaustion, slow queries

### 4. Scale Up (If Needed)

PostgreSQL allows you to scale beyond 2,000 addresses:
- Increase PM2 instances (adjust PG_POOL_SIZE accordingly)
- Add more RAM to PostgreSQL container
- Consider read replicas for heavy read workloads

---

## Support and Resources

### Documentation
- PostgreSQL Official Docs: https://www.postgresql.org/docs/
- TypeORM PostgreSQL Guide: https://typeorm.io/data-source-options#postgres-data-source-options
- BlitzPool GitHub: https://github.com/your-repo (if applicable)

### Monitoring Tools
- pgAdmin: https://www.pgadmin.org/
- pg_stat_statements: https://www.postgresql.org/docs/current/pgstatstatements.html
- Prometheus PostgreSQL Exporter: https://github.com/prometheus-community/postgres_exporter

### Community Support
- PostgreSQL Community: https://www.postgresql.org/community/
- Bitcoin Mining Pool Forums: (add relevant links)

---

## Conclusion

Congratulations on migrating to PostgreSQL! Your mining pool is now ready to scale to thousands of miners without SQLITE_BUSY errors.

**Remember:**
- Keep SQLite backup for 1 week
- Monitor performance for first 24 hours
- Set up automated PostgreSQL backups
- Enjoy true concurrent writes! 🚀

---

**Migration Prepared:** $(date)
**BlitzPool Version:** Latest (with PostgreSQL compatibility fixes)
**Estimated Downtime:** 10-20 minutes
**Risk Level:** Low (reversible with backup)
