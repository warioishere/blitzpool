import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';

interface PendingUpdate {
  payload: Partial<ClientStatisticsEntity>;
  timestamp: number;
}

/**
 * Batch statistics writer service
 *
 * Collects statistics updates in memory and flushes them periodically to reduce
 * database write operations. Critical for PM2 cluster mode with SQLite.
 *
 * Benefits:
 * - Reduces DB writes by batching multiple updates
 * - Better SQLite performance (single-writer bottleneck)
 * - Works well with PM2 cluster mode
 */
@Injectable()
export class StatisticsBatchService implements OnModuleInit, OnModuleDestroy {
  private pendingUpdates = new Map<string, PendingUpdate>();
  private pendingInserts = new Map<string, PendingUpdate>();
  private flushTimer?: NodeJS.Timeout;
  private flushIntervalMs: number;
  private isFlushing = false;
  private currentTimeSlot: number | null = null; // Track current slot for transition detection

  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly configService: ConfigService,
  ) {
    const configuredInterval = parseInt(
      this.configService.get<string>('STATISTICS_BATCH_WRITE_INTERVAL_MS') ?? '',
      10,
    );

    // Default: 1 minute (60000ms) - reduced from 5 minutes for faster slot updates
    this.flushIntervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : 60 * 1000;
  }

  async onModuleInit(): Promise<void> {
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch((error) => {
          console.error('StatisticsBatchService flush failed', error);
        });
      }, this.flushIntervalMs);

      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }

      console.log(`Statistics batch writer started (flush every ${this.flushIntervalMs / 1000}s)`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Final flush on shutdown
    await this.flush();
  }

  /**
   * Generate unique key for a statistics record
   */
  private getKey(address: string, clientName: string, sessionId: string, time: number): string {
    return `${address}:${clientName}:${sessionId}:${time}`;
  }

  /**
   * Get current time slot (10-minute intervals, end-time labeled)
   */
  private getTimeSlot(): number {
    const coeff = 1000 * 60 * 10; // 10 minutes
    // Time slot labeled by END time (e.g., slot "20:50" contains data from 20:40-20:50)
    return Math.floor(Date.now() / coeff) * coeff + coeff;
  }

  /**
   * Check for time slot transition and flush if needed
   * Flush is non-blocking to avoid blocking share processing
   */
  private checkAndHandleSlotTransition(): void {
    const currentSlot = this.getTimeSlot();

    // First call or same slot - no transition
    if (this.currentTimeSlot === null || this.currentTimeSlot === currentSlot) {
      this.currentTimeSlot = currentSlot;
      return;
    }

    // Slot transition detected - flush old data immediately (non-blocking)
    console.log(`[StatisticsBatch] Slot transition detected (${this.currentTimeSlot} -> ${currentSlot}), flushing immediately`);
    this.currentTimeSlot = currentSlot;

    // Flush asynchronously to ensure completed slot data is written to DB
    // Don't block share processing while flushing
    this.flush().catch((error) => {
      console.error('[StatisticsBatch] Slot transition flush failed:', error);
    });
  }

  /**
   * Queue a statistics update (for existing records)
   * Automatically flushes if a time slot transition is detected
   */
  public queueUpdate(payload: Partial<ClientStatisticsEntity>): void {
    if (!payload.address || !payload.clientName || !payload.sessionId || !payload.time) {
      console.warn('StatisticsBatchService: Invalid update payload, missing required fields');
      return;
    }

    // Check for slot transition and flush if needed (non-blocking)
    this.checkAndHandleSlotTransition();

    const key = this.getKey(
      payload.address,
      payload.clientName,
      payload.sessionId,
      payload.time,
    );

    this.pendingUpdates.set(key, {
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Queue a statistics insert (for new records)
   * Automatically flushes if a time slot transition is detected
   */
  public queueInsert(payload: Partial<ClientStatisticsEntity>): void {
    if (!payload.address || !payload.clientName || !payload.sessionId || !payload.time) {
      console.warn('StatisticsBatchService: Invalid insert payload, missing required fields');
      return;
    }

    // Check for slot transition and flush if needed (non-blocking)
    this.checkAndHandleSlotTransition();

    const key = this.getKey(
      payload.address,
      payload.clientName,
      payload.sessionId,
      payload.time,
    );

    this.pendingInserts.set(key, {
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Force immediate flush (useful before shutdown or for testing)
   */
  public async flush(): Promise<void> {
    if (this.isFlushing) {
      return; // Prevent concurrent flushes
    }

    const updateCount = this.pendingUpdates.size;
    const insertCount = this.pendingInserts.size;

    if (updateCount === 0 && insertCount === 0) {
      return; // Nothing to flush
    }

    this.isFlushing = true;

    try {
      // Process inserts first (new records) - SINGLE BULK INSERT
      if (insertCount > 0) {
        const allInserts = Array.from(this.pendingInserts.entries());

        // Filter out invalid records (missing required fields - happens when miners disconnect)
        const validInserts: Array<{ key: string; payload: Partial<ClientStatisticsEntity> }> = [];
        const invalidKeys: string[] = [];

        for (const [key, entry] of allInserts) {
          const p = entry.payload;
          if (!p.address || !p.clientName || !p.sessionId || !p.time) {
            console.warn('StatisticsBatchService: Skipping invalid insert (missing required fields, likely miner disconnect)');
            invalidKeys.push(key);
          } else {
            validInserts.push({ key, payload: p });
          }
        }

        // Remove invalid records immediately (they're not retryable)
        for (const key of invalidKeys) {
          this.pendingInserts.delete(key);
        }

        if (validInserts.length > 0) {
          // Process in batches of 1000 to stay under parameter limits
          // If one batch fails, others can still succeed
          const BATCH_SIZE = 1000;
          for (let i = 0; i < validInserts.length; i += BATCH_SIZE) {
            const batch = validInserts.slice(i, i + BATCH_SIZE);
            try {
              await this.clientStatisticsService.bulkInsert(batch.map(v => v.payload));
              // Success - clear only this batch
              for (const { key } of batch) {
                this.pendingInserts.delete(key);
              }
            } catch (error) {
              console.error(`StatisticsBatchService: Bulk insert batch ${i / BATCH_SIZE + 1} failed, keeping ${batch.length} records for retry:`, error);
              // Don't clear this batch - will retry on next flush
            }
          }
        }
      }

      // Process updates (existing records) - SINGLE BULK UPDATE
      if (updateCount > 0) {
        const allUpdates = Array.from(this.pendingUpdates.entries());

        // Filter out invalid records (missing required fields - happens when miners disconnect)
        const validUpdates: Array<{ key: string; payload: Partial<ClientStatisticsEntity> }> = [];
        const invalidKeys: string[] = [];

        for (const [key, entry] of allUpdates) {
          const p = entry.payload;
          if (!p.address || !p.clientName || !p.sessionId || !p.time) {
            console.warn('StatisticsBatchService: Skipping invalid update (missing required fields, likely miner disconnect)');
            invalidKeys.push(key);
          } else {
            validUpdates.push({ key, payload: p });
          }
        }

        // Remove invalid records immediately (they're not retryable)
        for (const key of invalidKeys) {
          this.pendingUpdates.delete(key);
        }

        if (validUpdates.length > 0) {
          // Process in batches of 1000 to stay under parameter limits
          // If one batch fails, others can still succeed
          const BATCH_SIZE = 1000;
          for (let i = 0; i < validUpdates.length; i += BATCH_SIZE) {
            const batch = validUpdates.slice(i, i + BATCH_SIZE);
            try {
              await this.clientStatisticsService.bulkUpdate(batch.map(v => v.payload));
              // Success - clear only this batch
              for (const { key } of batch) {
                this.pendingUpdates.delete(key);
              }
            } catch (error) {
              console.error(`StatisticsBatchService: Bulk update batch ${i / BATCH_SIZE + 1} failed, keeping ${batch.length} records for retry:`, error);
              // Don't clear this batch - will retry on next flush
            }
          }
        }
      }

      const actualInserts = insertCount - this.pendingInserts.size;
      const actualUpdates = updateCount - this.pendingUpdates.size;

      if (actualInserts > 0 || actualUpdates > 0) {
        console.log(`StatisticsBatchService: Flushed ${actualInserts} inserts, ${actualUpdates} updates`);
      }

      if (this.pendingInserts.size > 0 || this.pendingUpdates.size > 0) {
        console.warn(`StatisticsBatchService: ${this.pendingInserts.size} inserts and ${this.pendingUpdates.size} updates still pending (will retry next flush)`);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Get statistics about pending writes (for monitoring)
   */
  public getStats(): { pendingInserts: number; pendingUpdates: number } {
    return {
      pendingInserts: this.pendingInserts.size,
      pendingUpdates: this.pendingUpdates.size,
    };
  }
}
