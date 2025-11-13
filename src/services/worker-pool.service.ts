import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'worker_threads';
import { MetricsService } from './metrics.service';
import { cpus } from 'os';

/**
 * Worker Thread Pool Service - Phase 3 Performance Optimization
 *
 * Manages a pool of worker threads for CPU-intensive operations.
 * Currently experimental - enable with ENABLE_WORKER_THREADS=true
 *
 * Note: Worker threads add serialization overhead. Only beneficial for
 * operations that take >10ms to compute.
 */

interface WorkerTask {
  id: string;
  type: string;
  data: any;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  startTime: number;
}

@Injectable()
export class WorkerPoolService implements OnModuleInit, OnModuleDestroy {
  private enabled: boolean;
  private poolSize: number;
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private activeTasksByWorker: Map<Worker, WorkerTask | null> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
  ) {
    this.enabled = this.configService.get<string>('ENABLE_WORKER_THREADS')?.toLowerCase() === 'true';
    this.poolSize = parseInt(
      this.configService.get<string>('WORKER_THREAD_POOL_SIZE') ?? String(Math.max(1, cpus().length - 1)),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      console.log('[WorkerPool] Worker threads disabled (experimental feature)');
      return;
    }

    console.log(`[WorkerPool] Initializing worker thread pool with ${this.poolSize} workers`);

    // Note: Worker thread implementation would require a separate worker script
    // For now, this is a framework for future implementation
    console.log('[WorkerPool] Worker thread pool initialized (framework only - no workers created)');
    console.log('[WorkerPool] To fully implement: create worker scripts for CPU-intensive operations');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.enabled) return;

    console.log('[WorkerPool] Shutting down worker thread pool');

    // Terminate all workers
    for (const worker of this.workers) {
      await worker.terminate();
    }

    this.workers = [];
    this.activeTasksByWorker.clear();
    this.taskQueue = [];
  }

  /**
   * Execute a task on a worker thread
   * Falls back to synchronous execution if workers are disabled
   */
  async executeTask<T>(type: string, data: any, fallbackFn: () => T | Promise<T>): Promise<T> {
    // If workers are disabled, execute synchronously
    if (!this.enabled || this.workers.length === 0) {
      const startTime = Date.now();
      try {
        const result = await fallbackFn();
        const duration = Date.now() - startTime;
        this.metricsService.recordWorkerThreadJob(type, 'success', duration);
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        this.metricsService.recordWorkerThreadJob(type, 'failure', duration);
        throw error;
      }
    }

    // Find an available worker or queue the task
    return new Promise<T>((resolve, reject) => {
      const task: WorkerTask = {
        id: `${type}_${Date.now()}_${Math.random()}`,
        type,
        data,
        resolve,
        reject,
        startTime: Date.now(),
      };

      this.taskQueue.push(task);
      this.metricsService.workerThreadQueueSize.set(this.taskQueue.length);
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    // Find an idle worker
    for (const [worker, currentTask] of this.activeTasksByWorker.entries()) {
      if (currentTask === null) {
        const task = this.taskQueue.shift();
        if (!task) return;

        this.activeTasksByWorker.set(worker, task);
        this.metricsService.workerThreadQueueSize.set(this.taskQueue.length);

        // Send task to worker
        worker.postMessage({
          id: task.id,
          type: task.type,
          data: task.data,
        });

        return;
      }
    }
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): {
    enabled: boolean;
    poolSize: number;
    activeWorkers: number;
    queueSize: number;
  } {
    const activeWorkers = Array.from(this.activeTasksByWorker.values()).filter(
      (task) => task !== null,
    ).length;

    return {
      enabled: this.enabled,
      poolSize: this.poolSize,
      activeWorkers,
      queueSize: this.taskQueue.length,
    };
  }
}
