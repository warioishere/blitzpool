module.exports = {
  apps: [{
    name: 'blitzpool',
    script: 'dist/main.js',
    instances: process.env.PM2_INSTANCES || 4,
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      // Performance optimizations (Phase 1)
      SHARE_TOTALS_FLUSH_INTERVAL_MS: process.env.SHARE_TOTALS_FLUSH_INTERVAL_MS || '1800000',
      STATISTICS_BATCH_WRITE_INTERVAL_MS: process.env.STATISTICS_BATCH_WRITE_INTERVAL_MS || '300000',

      // API cache TTLs (Phase 1)
      API_CACHE_TTL_SITE_INFO: process.env.API_CACHE_TTL_SITE_INFO || '300',
      API_CACHE_TTL_POOL_INFO: process.env.API_CACHE_TTL_POOL_INFO || '600',
      API_CACHE_TTL_CHART: process.env.API_CACHE_TTL_CHART || '1800',
      API_CACHE_TTL_WORKERS: process.env.API_CACHE_TTL_WORKERS || '1800',

      // Redis configuration (Phase 2)
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
      REDIS_DB: process.env.REDIS_DB || '0',
      REDIS_TTL: process.env.REDIS_TTL || '600',

      // Pre-computed aggregations (Phase 2)
      ENABLE_AGGREGATION_SERVICE: process.env.ENABLE_AGGREGATION_SERVICE || 'true',
      AGGREGATION_INTERVAL_POOL_STATS: process.env.AGGREGATION_INTERVAL_POOL_STATS || '600000',
      AGGREGATION_INTERVAL_CHART_DATA: process.env.AGGREGATION_INTERVAL_CHART_DATA || '1800000',
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
  }]
};
