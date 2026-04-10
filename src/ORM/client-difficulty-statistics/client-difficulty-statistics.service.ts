import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientDifficultyStatisticsEntity } from './client-difficulty-statistics.entity';

const HOUR_IN_MS = 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 30_000;

interface BufferedDifficulty {
  address: string;
  clientName: string | null;
  slotTime: number;
  maxDifficulty: number;
}

@Injectable()
export class ClientDifficultyStatisticsService implements OnModuleDestroy {
  /** In-memory buffer: key = "address:clientName:slotTime" → max difficulty */
  private buffer = new Map<string, BufferedDifficulty>();
  private isFlushing = false;

  constructor(
    @InjectRepository(ClientDifficultyStatisticsEntity)
    private readonly repository: Repository<ClientDifficultyStatisticsEntity>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.flushBuffer();
  }

  private static normalizeSlot(timestamp: number): number {
    return Math.floor(timestamp / HOUR_IN_MS) * HOUR_IN_MS;
  }

  private static bufferKey(address: string, clientName: string | null, slotTime: number): string {
    return `${address}:${clientName ?? ''}:${slotTime}`;
  }

  /**
   * Record a share difficulty — buffered in-memory, flushed every 30s.
   * Only the maximum per (address, clientName, slotTime) is kept.
   */
  async recordShareDifficulty(params: {
    address: string;
    clientName?: string | null;
    timestamp?: number;
    difficulty: number;
  }): Promise<void> {
    if (!params.address || params.difficulty == null) {
      return;
    }

    const timestamp = params.timestamp ?? Date.now();
    const slotTime = ClientDifficultyStatisticsService.normalizeSlot(timestamp);
    const clientName = params.clientName ?? null;
    const key = ClientDifficultyStatisticsService.bufferKey(params.address, clientName, slotTime);

    const existing = this.buffer.get(key);
    if (existing) {
      if (params.difficulty > existing.maxDifficulty) {
        existing.maxDifficulty = params.difficulty;
      }
    } else {
      this.buffer.set(key, {
        address: params.address,
        clientName,
        slotTime,
        maxDifficulty: params.difficulty,
      });
    }
  }

  /**
   * Flush buffered difficulty records to PostgreSQL as batch UPSERT.
   * Runs every 30 seconds and on graceful shutdown.
   */
  @Interval(FLUSH_INTERVAL_MS)
  async flushBuffer(): Promise<void> {
    if (this.isFlushing || this.buffer.size === 0) {
      return;
    }

    this.isFlushing = true;

    // Swap buffer so new writes go to a fresh map while we flush
    const snapshot = this.buffer;
    this.buffer = new Map();

    try {
      const records = Array.from(snapshot.values());
      const databaseType = this.repository.manager.connection.options.type;

      if (databaseType === 'sqlite') {
        await this.flushSqlite(records);
      } else {
        await this.flushPostgres(records);
      }
    } catch (error) {
      // On failure, merge unflushed records back into the buffer (keep higher max)
      for (const record of snapshot.values()) {
        const key = ClientDifficultyStatisticsService.bufferKey(record.address, record.clientName, record.slotTime);
        const current = this.buffer.get(key);
        if (current) {
          current.maxDifficulty = Math.max(current.maxDifficulty, record.maxDifficulty);
        } else {
          this.buffer.set(key, record);
        }
      }
      console.error('[ClientDifficultyStatisticsService] Flush failed, records re-buffered:', error);
    } finally {
      this.isFlushing = false;
    }
  }

  private async flushPostgres(records: BufferedDifficulty[]): Promise<void> {
    const BATCH_SIZE = 500;
    const now = new Date();

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const valueParts: string[] = [];
      const params: any[] = [];

      for (let j = 0; j < batch.length; j++) {
        const r = batch[j];
        const o = j * 6;
        valueParts.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
        params.push(r.address, r.clientName, r.slotTime, r.maxDifficulty, now, now);
      }

      await this.repository.query(
        `INSERT INTO client_difficulty_statistics_entity (address, "clientName", "slotTime", "maxDifficulty", "createdAt", "updatedAt")
         VALUES ${valueParts.join(',')}
         ON CONFLICT ("address", "clientName", "slotTime") DO UPDATE SET
           "maxDifficulty" = CASE WHEN EXCLUDED."maxDifficulty" > client_difficulty_statistics_entity."maxDifficulty"
             THEN EXCLUDED."maxDifficulty" ELSE client_difficulty_statistics_entity."maxDifficulty" END,
           "updatedAt" = EXCLUDED."updatedAt"`,
        params,
      );
    }
  }

  private async flushSqlite(records: BufferedDifficulty[]): Promise<void> {
    const now = new Date().toISOString();
    for (const r of records) {
      const tableName = this.repository.metadata.tableName;
      await this.repository.query(
        `INSERT INTO ${tableName} (address, clientName, slotTime, maxDifficulty, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (address, clientName, slotTime)
         DO UPDATE SET
           maxDifficulty = CASE WHEN excluded.maxDifficulty > maxDifficulty THEN excluded.maxDifficulty ELSE maxDifficulty END,
           updatedAt = excluded.updatedAt`,
        [r.address, r.clientName, r.slotTime, r.maxDifficulty, now, now],
      );
    }
  }

  async getMaximaForAddress(address: string, from: number, to: number) {
    if (!address) {
      return [];
    }

    return this.repository
      .createQueryBuilder('stat')
      .select('stat.slotTime', 'slotTime')
      .addSelect('MAX(stat.maxDifficulty)', 'maxDifficulty')
      .where('stat.address = :address', { address })
      .andWhere('stat.slotTime BETWEEN :from AND :to', { from, to })
      .groupBy('stat.slotTime')
      .orderBy('stat.slotTime', 'ASC')
      .getRawMany<{ slotTime: number; maxDifficulty: number }>();
  }

  async deleteOlderThan(cutoff: number): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .delete()
      .from(ClientDifficultyStatisticsEntity)
      .where('slotTime < :cutoff', { cutoff })
      .execute();
  }

  async deleteForAddress(address: string): Promise<void> {
    await this.repository.delete({ address });
  }
}
