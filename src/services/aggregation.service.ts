import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientService } from '../ORM/client/client.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { MetricsService } from './metrics.service';

/**
 * Aggregation Service - Phase 2 Performance Optimization
 *
 * Pre-computes expensive aggregation queries and stores them in cache (Redis).
 * This reduces CPU load by computing statistics in background jobs instead of on-demand.
 *
 * Benefits:
 * - Reduced API response time (serve from cache)
 * - Lower database query load
 * - Better scalability under load
 * - Shared cache across all instances (when using Redis)
 */
@Injectable()
export class AggregationService implements OnModuleInit {
  private enabled: boolean;
  private poolStatsInterval: number;
  private chartDataInterval: number;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
  ) {
    this.enabled = this.configService.get<string>('ENABLE_AGGREGATION_SERVICE')?.toLowerCase() !== 'false';

    // Pool stats: every 10 minutes (default)
    this.poolStatsInterval = parseInt(
      this.configService.get<string>('AGGREGATION_INTERVAL_POOL_STATS') ?? '600000',
      10,
    );

    // Chart data: every 5 minutes (default) - aligns with statistics flush interval
    this.chartDataInterval = parseInt(
      this.configService.get<string>('AGGREGATION_INTERVAL_CHART_DATA') ?? '300000',
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) {
      console.log('[Aggregation] Service enabled - pre-computing statistics in background');
      console.log(`[Aggregation] Pool stats: every ${this.poolStatsInterval / 1000}s`);
      console.log(`[Aggregation] Chart data: every ${this.chartDataInterval / 1000}s`);

      // Run initial aggregations after 6 minutes to allow statistics to be flushed first
      // (Statistics batch service flushes every 5 minutes by default)
      setTimeout(() => {
        this.aggregatePoolStatistics().catch(err =>
          console.error('[Aggregation] Initial pool stats failed:', err)
        );
        this.aggregateChartData().catch(err =>
          console.error('[Aggregation] Initial chart data failed:', err)
        );
        this.aggregateSiteInfo().catch(err =>
          console.error('[Aggregation] Initial site info failed:', err)
        );
      }, 360000); // 6 minutes
    } else {
      console.log('[Aggregation] Service disabled');
    }
  }

  /**
   * Pre-compute pool statistics (every 10 minutes).
   *
   * Cron offset (sec=17) is intentional: keeps this job AWAY from the
   * `:x0:00` slot boundary where TimeSlotHelper rolls a new bucket and
   * StratumV1/V2 share-write traffic peaks. Running heavy aggregation
   * jobs at slot boundaries used to cluster four crons into the same
   * event-loop tick, blocking it ~1-2s and dropping shares from the
   * just-opened bucket. Each aggregation cron now has a distinct
   * second-offset so they neither collide with the slot boundary nor
   * with each other.
   */
  @Cron('17 */10 * * * *')
  async aggregatePoolStatistics(): Promise<void> {
    if (!this.enabled) return;

    const startTime = Date.now();
    try {
      const userAgents = await this.clientService.getUserAgents();
      const totalHashRate = userAgents.reduce(
        (acc, userAgent) => acc + parseFloat(userAgent.totalHashRate),
        0,
      );
      const totalMiners = userAgents.reduce(
        (acc, userAgent) => acc + parseInt(userAgent.count),
        0,
      );
      const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
      const blocksFound = await this.blocksService.getFoundBlocks();

      const data = {
        totalHashRate,
        blockHeight,
        totalMiners,
        blocksFound,
        fee: 0,
        _cachedAt: Date.now(),
      };

      await this.cacheManager.set('POOL_INFO', data, this.poolStatsInterval);

      // Update pool statistics metrics
      this.metricsService.updatePoolStats(totalHashRate, totalMiners);

      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('pool_stats', 'success', elapsed);
      console.log(`[Aggregation] Pool stats computed in ${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('pool_stats', 'failure', elapsed);
      console.error('[Aggregation] Failed to aggregate pool statistics:', error);
    }
  }

  /**
   * Pre-compute chart data for various ranges (every 5 minutes).
   * Sec-offset 37 — see `aggregatePoolStatistics` for rationale.
   */
  @Cron('37 */5 * * * *')
  async aggregateChartData(): Promise<void> {
    if (!this.enabled) return;

    const startTime = Date.now();
    try {
      const ranges: ('1d' | '1m')[] = ['1d', '1m'];

      for (const range of ranges) {
        const chartData = await this.clientStatisticsService.getChartDataForSite(range);
        // Only cache if we have actual data (not empty array)
        if (chartData && chartData.length > 0) {
          await this.cacheManager.set(
            `SITE_HASHRATE_GRAPH_${range}`,
            chartData,
            this.chartDataInterval,
          );
        }
      }

      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('chart_data', 'success', elapsed);
      console.log(`[Aggregation] Chart data computed in ${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('chart_data', 'failure', elapsed);
      console.error('[Aggregation] Failed to aggregate chart data:', error);
    }
  }

  /**
   * Pre-compute site info (every 5 minutes).
   * Sec-offset 52 — see `aggregatePoolStatistics` for rationale.
   */
  @Cron('52 */5 * * * *')
  async aggregateSiteInfo(): Promise<void> {
    if (!this.enabled) return;

    const startTime = Date.now();
    try {
      const blockData = await this.blocksService.getFoundBlocks();
      const userAgents = await this.clientService.getUserAgents();
      const highScores = await this.addressSettingsService.getHighScores();

      const data = {
        blockData,
        userAgents,
        highScores,
        uptime: new Date(), // This will be overridden by AppController
        _cachedAt: Date.now(),
      };

      await this.cacheManager.set('SITE_INFO', data, 300000); // 5 minute TTL (ms)

      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('site_info', 'success', elapsed);
      console.log(`[Aggregation] Site info computed in ${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('site_info', 'failure', elapsed);
      console.error('[Aggregation] Failed to aggregate site info:', error);
    }
  }

  /**
   * Pre-compute share totals (every 10 minutes).
   * Sec-offset 27 — see `aggregatePoolStatistics` for rationale.
   */
  @Cron('27 */10 * * * *')
  async aggregateShareTotals(): Promise<void> {
    if (!this.enabled) return;

    const startTime = Date.now();
    try {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const latestBlock = await this.blocksService.getLatestBlock();
      const sinceBlock = latestBlock?.createdAt ? latestBlock.createdAt.getTime() : 0;

      const [totals1d, totals14d, totals30d, totalsSinceBlock] = await Promise.all([
        this.poolShareStatisticsService.getTotalsSince(now - oneDay),
        this.poolShareStatisticsService.getTotalsSince(now - oneDay * 14),
        this.poolShareStatisticsService.getTotalsSince(now - oneDay * 30),
        this.poolShareStatisticsService.getTotalsSince(sinceBlock),
      ]);

      const data = {
        accepted1d: totals1d.accepted,
        rejected1d: totals1d.rejected,
        accepted14d: totals14d.accepted,
        rejected14d: totals14d.rejected,
        accepted30d: totals30d.accepted,
        rejected30d: totals30d.rejected,
        acceptedSinceBlock: totalsSinceBlock.accepted,
        rejectedSinceBlock: totalsSinceBlock.rejected,
        _cachedAt: Date.now(),
      };

      await this.cacheManager.set('POOL_SHARE_TOTALS', data, 600000); // 10 minute TTL (ms)

      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('share_totals', 'success', elapsed);
      console.log(`[Aggregation] Share totals computed in ${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.metricsService.recordAggregationJob('share_totals', 'failure', elapsed);
      console.error('[Aggregation] Failed to aggregate share totals:', error);
    }
  }

  /**
   * Get cache statistics (for monitoring)
   */
  public async getCacheStats(): Promise<{
    enabled: boolean;
    poolStatsInterval: number;
    chartDataInterval: number;
    cachedKeys: string[];
  }> {
    // Note: This requires Redis client access, simplified version here
    return {
      enabled: this.enabled,
      poolStatsInterval: this.poolStatsInterval,
      chartDataInterval: this.chartDataInterval,
      cachedKeys: [
        'POOL_INFO',
        'SITE_INFO',
        'POOL_SHARE_TOTALS',
        'SITE_HASHRATE_GRAPH_1d',
        'SITE_HASHRATE_GRAPH_1m',
      ],
    };
  }
}
