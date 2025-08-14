import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { PoolShareStatisticsService } from './ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from './ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { eStratumErrorCode } from './models/enums/eStratumErrorCode';

@Controller()
export class AppController {

  private uptime = new Date();
  private readonly version: string;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly poolShareStatisticsService: PoolShareStatisticsService,
    private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly stratumV1Service: StratumV1Service,
  ) {
    const packagePath = join(__dirname, '..', 'package.json');
    this.version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  }

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

  @Get('info/version')
  public infoVersion() {
    return { version: `v${this.version}` };
  }

  @Get('info/chart')
  public async infoChart(@Query('range') range: '1d' | '1m' = '1d') {
    const currentSlot = Math.floor(Date.now() / 600000) * 600000;
    const CACHE_KEY = `SITE_HASHRATE_GRAPH_${range}_${currentSlot}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite(range);
    const liveRate = this.stratumV1Service.getTotalHashRate();
    chartData.push({
      label: new Date(currentSlot).toISOString(),
      data: liveRate,
    });

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

    const data = {
      accepted1d: totals1d.accepted,
      rejected1d: totals1d.rejected,
      accepted14d: totals14d.accepted,
      rejected14d: totals14d.rejected,
      accepted30d: totals30d.accepted,
      rejected30d: totals30d.rejected,
      acceptedSinceBlock: totalsSinceBlock.accepted,
      rejectedSinceBlock: totalsSinceBlock.rejected,
    };

    await this.cacheManager.set(CACHE_KEY, data, 10 * 60 * 1000);

    return data;

  }

  @Get('info/accepted')
  public async infoAccepted(
    @Query('range') range: '1d' | '3d' | '7d' = '1d',
  ) {
    const CACHE_KEY = `POOL_ACCEPTED_STATS_${range}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
    const sinceTime = now - days * oneDay;

    const entries = await this.poolShareStatisticsService.getEntriesSince(sinceTime);
    const slotMap = new Map<number, number>();
    for (const entry of entries) {
      slotMap.set(entry.time, entry.accepted);
    }

    const coeff = 1000 * 60 * 10;
    const startSlot = Math.floor(sinceTime / coeff) * coeff;
    const endSlot = Math.floor(now / coeff) * coeff;
    const slotData: { time: string; counts: { accepted: number } }[] = [];
    for (let t = startSlot; t <= endSlot; t += coeff) {
      slotData.push({
        time: new Date(t).toISOString(),
        counts: { accepted: slotMap.get(t) || 0 },
      });
    }

    await this.cacheManager.set(CACHE_KEY, { slotData }, 10 * 60 * 1000);

    return { slotData };
  }

  @Get('info/rejected')
  public async infoRejected(
    @Query('range') range: '1d' | '3d' | '7d' = '1d',
  ) {

    const CACHE_KEY = `POOL_REJECTED_STATS_${range}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
    const sinceTime = now - days * oneDay;

    const entries = await this.poolRejectedStatisticsService.getEntriesSince(sinceTime);
    const slotMap = new Map<number, Record<string, number>>();
    for (const entry of entries) {
      if (!slotMap.has(entry.time)) {
        slotMap.set(entry.time, {});
      }
      const r = slotMap.get(entry.time);
      r[entry.reason] = entry.count;
    }

    const coeff = 1000 * 60 * 10;
    const startSlot = Math.floor(sinceTime / coeff) * coeff;
    const endSlot = Math.floor(now / coeff) * coeff;
    const allReasons = Object.keys(eStratumErrorCode).filter(k => isNaN(Number(k)));
    const slotData: { time: string; counts: Record<string, number> }[] = [];
    for (let t = startSlot; t <= endSlot; t += coeff) {
      const counts: Record<string, number> = {};
      for (const reason of allReasons) {
        counts[reason] = slotMap.get(t)?.[reason] || 0;
      }
      slotData.push({ time: new Date(t).toISOString(), counts });
    }

    await this.cacheManager.set(CACHE_KEY, { slotData }, 10 * 60 * 1000);

    return { slotData };
  }
}
