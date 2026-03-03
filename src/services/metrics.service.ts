import { Injectable, OnModuleInit } from '@nestjs/common';
import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Prometheus Metrics Service
 * Exposes performance and operational metrics for monitoring
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  // Stratum Server Metrics
  public readonly stratumSharesTotal = new Counter({
    name: 'stratum_shares_total',
    help: 'Total number of shares submitted',
    labelNames: ['status'], // valid, invalid, stale
  });

  public readonly stratumClientsConnected = new Gauge({
    name: 'stratum_clients_connected',
    help: 'Number of currently connected stratum clients',
    labelNames: ['protocol'],
  });

  public readonly stratumDifficultyAdjustments = new Counter({
    name: 'stratum_difficulty_adjustments_total',
    help: 'Total number of difficulty adjustments',
  });

  public readonly stratumJobsSent = new Counter({
    name: 'stratum_jobs_sent_total',
    help: 'Total number of mining jobs sent to clients',
  });

  public readonly stratumShareValidationDuration = new Histogram({
    name: 'stratum_share_validation_duration_seconds',
    help: 'Duration of share validation operations',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  });

  // API Metrics
  public readonly apiRequestDuration = new Histogram({
    name: 'api_request_duration_seconds',
    help: 'Duration of API requests',
    labelNames: ['method', 'endpoint', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
  });

  public readonly apiRequestsTotal = new Counter({
    name: 'api_requests_total',
    help: 'Total number of API requests',
    labelNames: ['method', 'endpoint', 'status'],
  });

  public readonly apiCacheHits = new Counter({
    name: 'api_cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['endpoint'],
  });

  public readonly apiCacheMisses = new Counter({
    name: 'api_cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['endpoint'],
  });

  // Database Metrics
  public readonly dbQueriesTotal = new Counter({
    name: 'db_queries_total',
    help: 'Total number of database queries',
    labelNames: ['operation', 'table'],
  });

  public readonly dbQueryDuration = new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries',
    labelNames: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
  });

  public readonly dbConnectionPoolSize = new Gauge({
    name: 'db_connection_pool_size',
    help: 'Current database connection pool size',
  });

  public readonly dbConnectionPoolActive = new Gauge({
    name: 'db_connection_pool_active',
    help: 'Number of active database connections',
  });

  // Redis Metrics
  public readonly redisCacheHits = new Counter({
    name: 'redis_cache_hits_total',
    help: 'Total number of Redis cache hits',
  });

  public readonly redisCacheMisses = new Counter({
    name: 'redis_cache_misses_total',
    help: 'Total number of Redis cache misses',
  });

  public readonly redisOperationDuration = new Histogram({
    name: 'redis_operation_duration_seconds',
    help: 'Duration of Redis operations',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  });

  public readonly redisMemoryUsage = new Gauge({
    name: 'redis_memory_usage_bytes',
    help: 'Redis memory usage in bytes',
  });

  // Aggregation Service Metrics
  public readonly aggregationJobDuration = new Histogram({
    name: 'aggregation_job_duration_seconds',
    help: 'Duration of aggregation jobs',
    labelNames: ['job_name'],
    buckets: [0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
  });

  public readonly aggregationJobsTotal = new Counter({
    name: 'aggregation_jobs_total',
    help: 'Total number of aggregation jobs executed',
    labelNames: ['job_name', 'status'], // success, failure
  });

  public readonly aggregationCacheSize = new Gauge({
    name: 'aggregation_cache_size_bytes',
    help: 'Size of aggregated data in cache',
    labelNames: ['cache_key'],
  });

  // Pool Statistics
  public readonly poolHashRate = new Gauge({
    name: 'pool_hashrate_hashes_per_second',
    help: 'Current pool hashrate in hashes per second',
  });

  public readonly poolMinersActive = new Gauge({
    name: 'pool_miners_active',
    help: 'Number of active miners',
  });

  public readonly poolBlocksFound = new Counter({
    name: 'pool_blocks_found_total',
    help: 'Total number of blocks found by the pool',
  });

  public readonly poolShareDifficulty = new Histogram({
    name: 'pool_share_difficulty',
    help: 'Difficulty of submitted shares',
    buckets: [1, 10, 100, 1000, 10000, 100000, 1000000],
  });

  // Worker Thread Metrics (Phase 3)
  public readonly workerThreadJobsTotal = new Counter({
    name: 'worker_thread_jobs_total',
    help: 'Total number of jobs processed by worker threads',
    labelNames: ['job_type', 'status'],
  });

  public readonly workerThreadJobDuration = new Histogram({
    name: 'worker_thread_job_duration_seconds',
    help: 'Duration of worker thread jobs',
    labelNames: ['job_type'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  });

  public readonly workerThreadPoolSize = new Gauge({
    name: 'worker_thread_pool_size',
    help: 'Number of worker threads in the pool',
  });

  public readonly workerThreadQueueSize = new Gauge({
    name: 'worker_thread_queue_size',
    help: 'Number of jobs waiting in worker thread queue',
  });

  onModuleInit() {
    // Enable default metrics (CPU, memory, event loop, etc.)
    collectDefaultMetrics({ register });
    console.log('[Metrics] Prometheus metrics service initialized');
  }

  /**
   * Get all metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return await register.metrics();
  }

  /**
   * Get metrics as JSON (for debugging)
   */
  async getMetricsJSON(): Promise<any> {
    return await register.getMetricsAsJSON();
  }

  /**
   * Clear all metrics (for testing)
   */
  clearMetrics(): void {
    register.clear();
  }

  /**
   * Record API request
   */
  recordApiRequest(method: string, endpoint: string, status: number, duration: number): void {
    this.apiRequestsTotal.inc({ method, endpoint, status: status.toString() });
    this.apiRequestDuration.observe(
      { method, endpoint, status: status.toString() },
      duration / 1000, // Convert ms to seconds
    );
  }

  /**
   * Record cache hit/miss
   */
  recordCacheAccess(endpoint: string, hit: boolean): void {
    if (hit) {
      this.apiCacheHits.inc({ endpoint });
    } else {
      this.apiCacheMisses.inc({ endpoint });
    }
  }

  /**
   * Record database query
   */
  recordDbQuery(operation: string, table: string, duration: number): void {
    this.dbQueriesTotal.inc({ operation, table });
    this.dbQueryDuration.observe({ operation, table }, duration / 1000);
  }

  /**
   * Record share submission
   */
  recordShareSubmission(status: 'valid' | 'invalid' | 'stale', difficulty: number, validationDuration?: number): void {
    this.stratumSharesTotal.inc({ status });
    this.poolShareDifficulty.observe(difficulty);

    if (validationDuration !== undefined) {
      this.stratumShareValidationDuration.observe(validationDuration / 1000);
    }
  }

  /**
   * Record aggregation job execution
   */
  recordAggregationJob(jobName: string, status: 'success' | 'failure', duration: number): void {
    this.aggregationJobsTotal.inc({ job_name: jobName, status });
    this.aggregationJobDuration.observe({ job_name: jobName }, duration / 1000);
  }

  /**
   * Update pool statistics
   */
  updatePoolStats(hashRate: number, activeMiners: number): void {
    this.poolHashRate.set(hashRate);
    this.poolMinersActive.set(activeMiners);
  }

  /**
   * Update connection pool stats
   */
  updateDbConnectionPool(total: number, active: number): void {
    this.dbConnectionPoolSize.set(total);
    this.dbConnectionPoolActive.set(active);
  }

  /**
   * Update Redis memory usage
   */
  updateRedisMemory(bytes: number): void {
    this.redisMemoryUsage.set(bytes);
  }

  /**
   * Record worker thread job
   */
  recordWorkerThreadJob(jobType: string, status: 'success' | 'failure', duration: number): void {
    this.workerThreadJobsTotal.inc({ job_type: jobType, status });
    this.workerThreadJobDuration.observe({ job_type: jobType }, duration / 1000);
  }

  /**
   * Update worker thread pool stats
   */
  updateWorkerThreadPool(poolSize: number, queueSize: number): void {
    this.workerThreadPoolSize.set(poolSize);
    this.workerThreadQueueSize.set(queueSize);
  }
}
