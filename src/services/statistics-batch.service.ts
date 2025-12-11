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

  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly configService: ConfigService,
  ) {
    const configuredInterval = parseInt(
      this.configService.get<string>('STATISTICS_BATCH_WRITE_INTERVAL_MS') ?? '',
      10,
    );

    // Default: 1 minute (60000ms) - Reduced from 5 minutes for more responsive statistics
    this.flushIntervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : 1 * 60 * 1000;
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
   * Queue a statistics update (for existing records)
   */
  public queueUpdate(payload: Partial<ClientStatisticsEntity>): void {
    if (!payload.address || !payload.clientName || !payload.sessionId || !payload.time) {
      console.warn('StatisticsBatchService: Invalid update payload, missing required fields');
      return;
    }

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
   */
  public queueInsert(payload: Partial<ClientStatisticsEntity>): void {
    if (!payload.address || !payload.clientName || !payload.sessionId || !payload.time) {
      console.warn('StatisticsBatchService: Invalid insert payload, missing required fields');
      return;
    }

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
