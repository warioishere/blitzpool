# Quick Migration Steps - BlitzPool SQLite → PostgreSQL

**⏱️ Estimated Time: 15-20 minutes**

---

## Pre-Flight Checklist

```bash
# 1. Backup SQLite database
mkdir -p /home/blitzpool/public-pool/backups
cp /home/blitzpool/public-pool/full-setup/data/mainnet/public-pool/public-pool.sqlite \
   /home/blitzpool/public-pool/backups/public-pool-$(date +%Y%m%d-%H%M%S).sqlite

# 2. Stop current pool
cd /home/blitzpool/public-pool/full-setup
docker-compose down

# 3. Verify backup exists
ls -lh /home/blitzpool/public-pool/backups/
```

---

## Migration Steps

### 1. Build Updated Code (with PostgreSQL fixes)

```bash
cd /home/blitzpool/public-pool
docker build -f Dockerfile_pm2 -t blitzpool-pm2:latest .
```

### 2. Start PostgreSQL Stack

```bash
cd /home/blitzpool/public-pool/full-setup
docker-compose -f docker-compose-mainnet-pg-pm2.yml up -d postgres redis bitcoin

# Wait for PostgreSQL ready message (~15 seconds)
docker-compose -f docker-compose-mainnet-pg-pm2.yml logs -f postgres
# Look for: "database system is ready to accept connections"
# Press Ctrl+C
```

### 3. Start BlitzPool (Auto-Migration)

```bash
cd /home/blitzpool/public-pool/full-setup
docker-compose -f docker-compose-mainnet-pg-pm2.yml up -d public-pool

# Watch migration in real-time
docker logs -f public-pool
```

**Expected Migration Output:**
```
[Migration] Starting migration from SQLite to Postgres...
[address_settings_entity] Migrating 818 rows...
[client_statistics_entity] Migrating 125000 rows...
...
[Migration] Migration finished.
[ShareTotalsCacheService] Using Redis for shared cache
[StratumV1Service] Stratum server listening on port 3333
```

### 4. Verify Migration Success

```bash
# Check row counts
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT 'address_settings' AS table, COUNT(*) FROM address_settings_entity
  UNION ALL
  SELECT 'statistics', COUNT(*) FROM client_statistics_entity;
"

# Verify share totals (top 10)
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT address, shares FROM address_settings_entity
  ORDER BY shares DESC LIMIT 10;
"

# Check for errors (should be empty)
docker logs public-pool | grep -i "error" | grep -i "sql"

# Test API endpoint
curl http://localhost:3334/api/pool/info | jq
```

---

## ✅ Success Criteria

Migration successful if:

- ✅ Row counts match SQLite
- ✅ Share totals match
- ✅ No SQL errors in logs
- ✅ API returns data
- ✅ Stratum server listening on :3333

---

## 🔄 Rollback (If Needed)

```bash
cd /home/blitzpool/public-pool/full-setup

# Stop everything
docker-compose -f docker-compose-mainnet-pg-pm2.yml down

# Restore SQLite backup
cp /home/blitzpool/public-pool/backups/public-pool-*.sqlite \
   ./data/mainnet/public-pool/public-pool.sqlite

# Start with original SQLite config
# (Use your original docker-compose file)
```

---

## 📊 Monitor Performance (First 24 Hours)

```bash
# Watch share flush performance
docker logs -f public-pool | grep "Flushed"
# Target: < 100ms for bulk UPDATE

# Check PostgreSQL connections
docker exec -it public-pool-postgres psql -U postgres -d public_pool -c "
  SELECT state, count(*) FROM pg_stat_activity
  WHERE datname = 'public_pool' GROUP BY state;
"
# Should be < 100 connections

# Monitor for errors
docker logs -f public-pool | grep -i error
```

---

## 📝 What Changed

### Code Fixes Applied:
1. ✅ `addSharesBulk()` - PostgreSQL placeholder support ($1, $2 vs ?)
2. ✅ `timeslot-migration.service.ts` - Database-aware placeholders
3. ✅ All raw SQL queries - Compatible with both databases

### Configuration:
- ✅ `blitzpool-pg.env` - PostgreSQL connection settings
- ✅ `docker-compose-mainnet-pg-pm2.yml` - Uses PostgreSQL env file
- ✅ Connection pooling: 23 per PM2 instance (4 instances = 92 total)

### Performance Optimizations:
- Share flush: 10 seconds (vs 30 sec on SQLite)
- Statistics flush: 5 minutes (vs 30 min on SQLite)
- Connection pool: Tuned for 4 PM2 instances
- Query timeout: 30 seconds
- Idle timeout: 10 seconds

---

## 🎯 Next Steps After Migration

1. **Keep SQLite backup for 1 week**
2. **Monitor first 24 hours closely**
3. **Set up automated PostgreSQL backups**
4. **Enjoy no more SQLITE_BUSY errors!** 🎉

---

**Full Documentation:** See `POSTGRESQL_MIGRATION_GUIDE.md`
