import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject, Query, Param } from '@nestjs/common';
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
import { GeoIpService } from './services/geoip.service';
import { eStratumErrorCode } from './models/enums/eStratumErrorCode';
import { isIP } from 'net';
import { ConfigService } from '@nestjs/config';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { MiningJob } from './models/MiningJob';
import * as bitcoinjs from 'bitcoinjs-lib';

function extractHost(addr: string): string {
  if (!addr) return '';
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    return addr.substring(1, end);
  }
  return addr.split(':')[0];
}

function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 127) return false;
    return true;
  } else if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false;
    return true;
  }
  return false;
}

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
    private readonly geoIpService: GeoIpService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
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
    await this.cacheManager.set(CACHE_KEY, data, 1 * 60);

    return data;

  }

  @Get('info/block-template')
  public async blockTemplate() {
    const height = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
    return this.bitcoinRpcService.getBlockTemplate(height);
  }

  @Get('info/core')
  public async infoCore() {
    const CACHE_KEY = 'CORE_INFO';
    const cached = await this.cacheManager.get(CACHE_KEY);
    if (cached != null) {
      return cached;
    }
    const data = await this.bitcoinRpcService.getNetworkInfo();
    await this.cacheManager.set(CACHE_KEY, data, 60);
    return data;
  }

  @Get('client/:address/block-template')
  public async clientBlockTemplate(@Param('address') address: string) {
    const tpl = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);

    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
    const devFeePercent = parseFloat(
      this.configService.get('DEV_FEE_PERCENT') ?? '1.5',
    );

    let payoutInformation;
    if (devFeeAddress == null || devFeeAddress.length < 1) {
      payoutInformation = [{ address, percent: 100 }];
    } else {
      payoutInformation = [
        { address: devFeeAddress, percent: devFeePercent },
        { address, percent: 100 - devFeePercent },
      ];
    }

    const networkConfig = this.configService.get('NETWORK');
    let network: bitcoinjs.networks.Network;
    if (networkConfig === 'mainnet') {
      network = bitcoinjs.networks.bitcoin;
    } else if (networkConfig === 'testnet') {
      network = bitcoinjs.networks.testnet;
    } else if (networkConfig === 'regtest') {
      network = bitcoinjs.networks.regtest;
    } else {
      throw new Error('Invalid network configuration');
    }

    const job = new MiningJob(
      this.configService,
      network,
      this.stratumV1JobsService.getNextId(),
      payoutInformation,
      tpl,
    );

    const block = job.copyAndUpdateBlock(
      tpl,
      0,
      0,
      '00000000',
      '0000000000000000',
      tpl.block.timestamp,
    );

    const blockTemplate = await this.bitcoinRpcService.getBlockTemplate(
      tpl.blockData.height,
    );

    return {
      blockTemplate,
      blockHex: block.toHex(),
      coinbaseTxHex: job.getCoinbaseTxHex(),
    };
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
    await this.cacheManager.set(CACHE_KEY, data, 5 * 60);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  @Get('info/peers')
  public async infoPeers() {
    const CACHE_KEY = 'PEER_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);
    if (cachedResult != null) {
      return cachedResult;
    }

    const peers = await this.bitcoinRpcService.getPeerInfo() || [];
    const result = await Promise.all(
      peers.map(async p => {
        const host = extractHost(p.addr);
        let location: string;
        if (host.includes('.onion')) {
          location = 'hidden through tor';
        } else if (host.includes('.i2p')) {
          location = 'hidden through i2p';
        } else if (!isPublicIp(host)) {
          location = 'hidden through tor';
        } else {
          const geo = await this.geoIpService.getLocation(host);
          location = geo ? `${geo.city}, ${geo.country}` : null;
        }
        return {
          version: p.subver,
          direction: p.inbound ? 'inbound' : 'outbound',
          location,
          bytesrecv: p.bytesrecv,
          bytessent: p.bytessent,
          network: p.network,
          pingtime: p.pingtime,
        };
      })
    );

    await this.cacheManager.set(CACHE_KEY, result, 1 * 60);
    return result;
  }

  @Get('info/version')
  public infoVersion() {
    return { version: `v${this.version}` };
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
    await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60);

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

    await this.cacheManager.set(CACHE_KEY, data, 10 * 60);

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

    await this.cacheManager.set(CACHE_KEY, { slotData }, 10 * 60);

    return { slotData };
  }

  @Get('info/workers')
  public async infoWorkers(
    @Query('range') range: '1d' | '3d' | '7d' = '1d',
  ) {
    const CACHE_KEY = `POOL_WORKER_STATS_${range}`;
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const days = range === '7d' ? 7 : range === '3d' ? 3 : 1;
    const sinceTime = now - days * oneDay;

    const entries = await this.clientStatisticsService.getActiveCountsSince(
      sinceTime,
    );
    const slotMap = new Map<number, { addresses: number; workers: number }>();
    for (const entry of entries) {
      slotMap.set(entry.time, {
        addresses: entry.addresses,
        workers: entry.workers,
      });
    }

    const coeff = 1000 * 60 * 10;
    const startSlot = Math.floor(sinceTime / coeff) * coeff;
    const endSlot = Math.floor(now / coeff) * coeff;
    const slotData: {
      time: string;
      counts: { addresses: number; workers: number };
    }[] = [];
    for (let t = startSlot; t <= endSlot; t += coeff) {
      const counts = slotMap.get(t) || {
        addresses: 0,
        workers: 0,
      };
      slotData.push({
        time: new Date(t).toISOString(),
        counts,
      });
    }

    const currentSlot = Math.floor(now / coeff) * coeff;
    if (endSlot === currentSlot && slotData.length > 0) {
      const liveCounts = await this.clientService.getActiveWorkerCounts();
      slotData[slotData.length - 1].counts = liveCounts;
    }

    await this.cacheManager.set(CACHE_KEY, { slotData }, 10 * 60);

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

    await this.cacheManager.set(CACHE_KEY, { slotData }, 10 * 60);

    return { slotData };
  }
}
