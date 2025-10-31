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

    const updatedAt = new Date();

    try {
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
        .setParameter('updatedAt', updatedAt)
        .execute();
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
}
