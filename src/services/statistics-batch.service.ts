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
      // Process inserts first (new records)
      if (insertCount > 0) {
        const inserts = Array.from(this.pendingInserts.values()).map(entry => entry.payload);
        this.pendingInserts.clear();

        // Insert in batches of 50 to avoid memory issues
        for (let i = 0; i < inserts.length; i += 50) {
          const batch = inserts.slice(i, i + 50);
          try {
            for (const payload of batch) {
              await this.clientStatisticsService.insert(payload);
            }
          } catch (error) {
            console.error('StatisticsBatchService: Failed to insert batch', error);
          }
        }
      }

      // Process updates (existing records)
      if (updateCount > 0) {
        const updates = Array.from(this.pendingUpdates.values()).map(entry => entry.payload);
        this.pendingUpdates.clear();

        // Update in batches of 50
        for (let i = 0; i < updates.length; i += 50) {
          const batch = updates.slice(i, i + 50);
          try {
            for (const payload of batch) {
              await this.clientStatisticsService.update(payload);
            }
          } catch (error) {
            console.error('StatisticsBatchService: Failed to update batch', error);
          }
        }
      }

      if (updateCount > 0 || insertCount > 0) {
        console.log(`StatisticsBatchService: Flushed ${insertCount} inserts, ${updateCount} updates`);
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
