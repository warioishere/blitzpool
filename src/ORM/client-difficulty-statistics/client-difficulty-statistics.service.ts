import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientDifficultyStatisticsEntity } from './client-difficulty-statistics.entity';

const HOUR_IN_MS = 60 * 60 * 1000;

@Injectable()
export class ClientDifficultyStatisticsService {
  constructor(
    @InjectRepository(ClientDifficultyStatisticsEntity)
    private readonly repository: Repository<ClientDifficultyStatisticsEntity>,
  ) {}

  private static normalizeSlot(timestamp: number): number {
    return Math.floor(timestamp / HOUR_IN_MS) * HOUR_IN_MS;
  }

  private static isUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === 'SQLITE_CONSTRAINT' || code === '23505';
  }

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

    const now = new Date();

    try {
      const databaseType = this.repository.manager.connection.options.type;

      if (databaseType === 'sqlite') {
        // SQLite: Use raw SQL to avoid RETURNING clause issues
        const tableName = this.repository.metadata.tableName;
        const nowISO = now.toISOString();
        await this.repository.query(
          `INSERT INTO ${tableName} (address, clientName, slotTime, maxDifficulty, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (address, clientName, slotTime)
           DO UPDATE SET
             maxDifficulty = CASE WHEN excluded.maxDifficulty > maxDifficulty THEN excluded.maxDifficulty ELSE maxDifficulty END,
             updatedAt = excluded.updatedAt`,
          [params.address, clientName, slotTime, params.difficulty, nowISO, nowISO],
        );
      } else {
        // PostgreSQL: Query builder with RETURNING works fine
        await this.repository
          .createQueryBuilder()
          .insert()
          .into(ClientDifficultyStatisticsEntity)
          .values({
            address: params.address,
            clientName,
            slotTime,
            maxDifficulty: params.difficulty,
          })
          .onConflict(
            '("address", "clientName", "slotTime") DO UPDATE SET "maxDifficulty" = CASE WHEN EXCLUDED."maxDifficulty" > "maxDifficulty" THEN EXCLUDED."maxDifficulty" ELSE "maxDifficulty" END, "updatedAt" = :updatedAt',
          )
          .setParameter('updatedAt', now)
          .execute();
      }
    } catch (error) {
      if (!ClientDifficultyStatisticsService.isUniqueConstraintError(error)) {
        throw error;
      }
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
