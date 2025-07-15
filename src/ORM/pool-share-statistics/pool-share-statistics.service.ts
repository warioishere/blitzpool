import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PoolShareStatisticsEntity } from './pool-share-statistics.entity';

@Injectable()
export class PoolShareStatisticsService {
  constructor(
    @InjectRepository(PoolShareStatisticsEntity)
    private poolShareStatisticsRepository: Repository<PoolShareStatisticsEntity>,
  ) {}

  public async insert(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.insert(stat);
  }

  public async update(stat: Partial<PoolShareStatisticsEntity>) {
    await this.poolShareStatisticsRepository.update(
      { time: stat.time },
      {
        accepted: stat.accepted,
        rejected: stat.rejected,
        updatedAt: new Date(),
      },
    );
  }

  public async getTotalsSince(
    time: number,
  ): Promise<{ accepted: number; rejected: number }> {
    const result = await this.poolShareStatisticsRepository
      .createQueryBuilder('stat')
      .select('SUM(stat.accepted)', 'accepted')
      .addSelect('SUM(stat.rejected)', 'rejected')
      .where('stat.time > :time', { time })
      .getRawOne();
    return {
      accepted: result?.accepted ? parseFloat(result.accepted) : 0,
      rejected: result?.rejected ? parseFloat(result.rejected) : 0,
    };
  }
}
