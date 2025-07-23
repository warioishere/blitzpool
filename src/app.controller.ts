import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { PoolShareStatisticsService } from './ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from './ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

@Controller()
export class AppController {

  private uptime = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
  ) { }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();
    const highScores = await this.addressSettingsService.getHighScores();

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime
    };

    //1 min
    await this.cacheManager.set(CACHE_KEY, data, 1 * 60 * 1000);

    return data;

  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const userAgents = await this.clientService.getUserAgents();
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseInt(userAgent.count), 0);
    const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
    const blocksFound = await this.blocksService.getFoundBlocks();

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: 0
    }

    //5 min
    await this.cacheManager.set(CACHE_KEY, data, 5 * 60 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  @Get('info/chart')
  public async infoChart(@Query('range') range: '1d' | '1m' = '1d') {


    const CACHE_KEY = `SITE_HASHRATE_GRAPH_${range}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite(range);

    //10 min
    await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60 * 1000);

    return chartData;


  }

  @Get('info/shares')
  public async infoShares() {

    const CACHE_KEY = 'POOL_SHARE_TOTALS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const latestBlock = await this.blocksService.getLatestBlock();
    const sinceBlock = latestBlock?.createdAt ? latestBlock.createdAt.getTime() : 0;

    const totals1d = await this.poolShareStatisticsService.getTotalsSince(now - oneDay);
    const totals14d = await this.poolShareStatisticsService.getTotalsSince(now - oneDay * 14);
    const totals30d = await this.poolShareStatisticsService.getTotalsSince(now - oneDay * 30);
    const totalsSinceBlock = await this.poolShareStatisticsService.getTotalsSince(sinceBlock);

    const rejected1dMap = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay);
    const rejected14dMap = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay * 14);
    const rejected30dMap = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay * 30);
    const rejectedSinceBlockMap = await this.poolRejectedStatisticsService.getTotalsSince(sinceBlock);

    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

    const data = {
      accepted1d: totals1d.accepted,
      rejected1d: sum(rejected1dMap),
      accepted14d: totals14d.accepted,
      rejected14d: sum(rejected14dMap),
      accepted30d: totals30d.accepted,
      rejected30d: sum(rejected30dMap),
      acceptedSinceBlock: totalsSinceBlock.accepted,
      rejectedSinceBlock: sum(rejectedSinceBlockMap),
    };

    await this.cacheManager.set(CACHE_KEY, data, 10 * 60 * 1000);

    return data;

  }

  @Get('info/rejected')
  public async infoRejected() {

    const CACHE_KEY = 'POOL_REJECTED_STATS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    const entries = await this.poolRejectedStatisticsService.getEntriesSince(now - oneDay);
    const slotMap = new Map<number, Record<string, number>>();
    for (const entry of entries) {
      if (!slotMap.has(entry.time)) {
        slotMap.set(entry.time, {});
      }
      const r = slotMap.get(entry.time);
      r[entry.reason] = entry.count;
    }
    const slotData = Array.from(slotMap.entries()).map(([time, reasons]) => ({
      time: new Date(time).toISOString(),
      counts: reasons,
    }));

    const totals1d = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay);
    const totals3d = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay * 3);
    const totals7d = await this.poolRejectedStatisticsService.getTotalsSince(now - oneDay * 7);

    const data = { slotData, totals1d, totals3d, totals7d };

    await this.cacheManager.set(CACHE_KEY, data, 10 * 60 * 1000);

    return data;
  }
}
