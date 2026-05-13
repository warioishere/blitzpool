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
import { eStratumErrorCode, STRATUM_REJECT_STALE } from './models/enums/eStratumErrorCode';
import { isIP } from 'net';
import { ConfigService } from '@nestjs/config';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { MetricsService } from './services/metrics.service';
import { MiningJob } from './models/MiningJob';
import * as bitcoinjs from 'bitcoinjs-lib';
import { generateFormattedTimeSlots } from './utils/timeslot.utils';

import { MiningModeService } from './services/mining-mode.service';
import { PplnsService } from './services/pplns.service';
import { GroupSoloService } from './services/group-solo.service';
import { PoolModeHashrateService } from './ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import type { MiningMode } from './services/mining-mode.service';

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

  // Configurable cache TTLs (env values in seconds, converted to ms for cache-manager)
  private readonly cacheTTL = {
    siteInfo: parseInt(this.configService.get('API_CACHE_TTL_SITE_INFO') ?? '300') * 1000,
    poolInfo: parseInt(this.configService.get('API_CACHE_TTL_POOL_INFO') ?? '600') * 1000,
    coreInfo: parseInt(this.configService.get('API_CACHE_TTL_CORE_INFO') ?? '60') * 1000,
    peerInfo: parseInt(this.configService.get('API_CACHE_TTL_PEER_INFO') ?? '60') * 1000,
    chart: parseInt(this.configService.get('API_CACHE_TTL_CHART') ?? '60') * 1000,
    shares: parseInt(this.configService.get('API_CACHE_TTL_SHARES') ?? '60') * 1000,
    workers: parseInt(this.configService.get('API_CACHE_TTL_WORKERS') ?? '60') * 1000,
    accepted: parseInt(this.configService.get('API_CACHE_TTL_ACCEPTED') ?? '60') * 1000,
    rejected: parseInt(this.configService.get('API_CACHE_TTL_REJECTED') ?? '60') * 1000,
    clientBlockTemplate: parseInt(this.configService.get('API_CACHE_TTL_CLIENT_BLOCK_TEMPLATE') ?? '60') * 1000,
  };

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
    private readonly metricsService: MetricsService,
    private readonly miningModeService: MiningModeService,
    private readonly pplnsService: PplnsService,
    private readonly groupSoloService: GroupSoloService,
    private readonly poolModeHashrateService: PoolModeHashrateService,
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

    await this.cacheManager.set(CACHE_KEY, data, this.cacheTTL.siteInfo);

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
    await this.cacheManager.set(CACHE_KEY, data, this.cacheTTL.coreInfo);
    return data;
  }

  @Get('client/:address/block-template')
  public async clientBlockTemplate(@Param('address') address: string) {
    const tpl = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);

    // Cache the assembled response per (address, jobTemplateId). The template
    // id is monotonically increasing and changes on every newMiningJob$
    // emit (~1/min) — caching by (address, id) naturally invalidates on
    // template change. Skips a full MiningJob construction (+ copyAndUpdateBlock
    // 80-byte header build + getblocktemplate JSON marshalling) on repeat
    // polls from the same dashboard.
    const cacheKey = `CLIENT_BLOCK_TEMPLATE_${address}_${tpl.blockData.id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached != null) {
      return cached;
    }

    // Build payoutInformation that matches the actual coinbase the pool would
    // produce for this miner. In PPLNS/group-solo the coinbase is a multi-output
    // distribution, not a solo payout — returning a solo-shaped template here
    // would mislead the miner.
    const modeResult = await this.miningModeService.getMode(address);
    let payoutInformation;
    let mode: 'solo' | 'pplns' | 'group-solo' = modeResult.mode;

    if (modeResult.mode === 'group-solo' && modeResult.groupId && this.groupSoloService.isEnabled()) {
      // Pass the requesting address as finderAddress so the UI's block-template
      // preview shows THIS miner's coinbase (with their bonus output), matching
      // the per-miner template the stratum layer would actually send them.
      const distribution = await this.groupSoloService.getPayoutDistribution(
        modeResult.groupId,
        tpl.blockData.coinbasevalue,
        address,
      );
      if (distribution && distribution.length > 0) {
        payoutInformation = distribution;
      }
    } else if (modeResult.mode === 'pplns' && this.pplnsService.isEnabled()) {
      const distribution = await this.pplnsService.getPayoutDistribution(
        tpl.blockData.coinbasevalue,
      );
      if (distribution && distribution.length > 0) {
        payoutInformation = distribution;
      }
    }

    // Fall back to solo if: mode is solo, or mode lookup produced an empty
    // distribution (e.g. PPLNS window is empty right now). Behavior matches
    // what StratumV1Client does on a solo port.
    if (!payoutInformation) {
      mode = 'solo';
      const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
      const devFeePercent = parseFloat(
        this.configService.get('DEV_FEE_PERCENT') ?? '1.5',
      );
      if (devFeeAddress == null || devFeeAddress.length < 1) {
        payoutInformation = [{ address, percent: 100 }];
      } else {
        payoutInformation = [
          { address: devFeeAddress, percent: devFeePercent },
          { address, percent: 100 - devFeePercent },
        ];
      }
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

    const result = {
      blockTemplate,
      blockHex: block.toHex(),
      coinbaseTxHex: job.getCoinbaseTxHex(),
      mode,
      payoutInformation,
      ...(modeResult.mode === 'group-solo' && modeResult.groupId
        ? { groupId: modeResult.groupId }
        : {}),
    };
    await this.cacheManager.set(cacheKey, result, this.cacheTTL.clientBlockTemplate);
    return result;
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

    await this.cacheManager.set(CACHE_KEY, data, this.cacheTTL.poolInfo);

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

    await this.cacheManager.set(CACHE_KEY, result, this.cacheTTL.peerInfo);
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

    // Only use cache if it has actual data (not empty array)
    if (cachedResult != null && Array.isArray(cachedResult) && cachedResult.length > 0) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite(range);

    // Only cache if we have data
    if (chartData && chartData.length > 0) {
      await this.cacheManager.set(CACHE_KEY, chartData, this.cacheTTL.chart);
    }

    return chartData;


  }

  /**
   * Per-payout-mode hashrate chart. Reads from `pool_mode_hashrate` which
   * is incremented on every accepted share with its routed payout mode,
   * so "Solo" / "PPLNS" / "Group-Solo" curves reflect the work actually
   * routed to each mode — no retrospective address-state derivation.
   *
   * Shape is drop-in compatible with /api/info/chart: [{ label, data }].
   */
  @Get('info/chart/mode/:mode')
  public async infoChartMode(
    @Param('mode') mode: string,
    @Query('range') range: '1d' | '3d' | '7d' = '7d',
  ) {
    const validModes: MiningMode[] = ['solo', 'pplns', 'group-solo'];
    if (!validModes.includes(mode as MiningMode)) {
      return [];
    }
    const validRange: '1d' | '3d' | '7d' =
      range === '3d' ? '3d' : range === '7d' ? '7d' : '1d';
    return this.poolModeHashrateService.getChart(mode as MiningMode, validRange);
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

    const [latestBlock, totals1d, totals14d, totals30d] = await Promise.all([
      this.blocksService.getLatestBlock(),
      this.poolShareStatisticsService.getTotalsSince(now - oneDay),
      this.poolShareStatisticsService.getTotalsSince(now - oneDay * 14),
      this.poolShareStatisticsService.getTotalsSince(now - oneDay * 30),
    ]);
    const sinceBlock = latestBlock?.createdAt ? latestBlock.createdAt.getTime() : 0;
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

    await this.cacheManager.set(CACHE_KEY, data, this.cacheTTL.shares);

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

    const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => ({
      counts: { accepted: slotMap.get(t) || 0 },
    }));

    await this.cacheManager.set(CACHE_KEY, { slotData }, this.cacheTTL.accepted);

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

    const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => ({
      counts: slotMap.get(t) || { addresses: 0, workers: 0 },
    }));

    await this.cacheManager.set(CACHE_KEY, { slotData }, this.cacheTTL.workers);

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

    // `allReasons` is the union of the wire-level error-code names from
    // `eStratumErrorCode` (JobNotFound, DuplicateShare, etc.) PLUS the
    // internal-only `STRATUM_REJECT_STALE` ('Stale') counter introduced
    // by the ckpool-style retire-then-age refactor. The Stale counter
    // tracks shares against a retired-but-still-known job that arrived
    // beyond the 5-second grace window — distinct from JobNotFound,
    // which fires only when the job is genuinely GC'd from memory.
    const allReasons = [
      ...Object.keys(eStratumErrorCode).filter(k => isNaN(Number(k))),
      STRATUM_REJECT_STALE,
    ];
    const slotData = generateFormattedTimeSlots(sinceTime, now, (t) => {
      const counts: Record<string, number> = {};
      for (const reason of allReasons) {
        counts[reason] = slotMap.get(t)?.[reason] || 0;
      }
      return { counts };
    });

    await this.cacheManager.set(CACHE_KEY, { slotData }, this.cacheTTL.rejected);

    return { slotData };
  }

  /**
   * Prometheus metrics endpoint
   * Exposes all performance and operational metrics
   */
  @Get('metrics')
  public async metrics() {
    return await this.metricsService.getMetrics();
  }

  /**
   * Health check endpoint with detailed status
   */
  @Get('health')
  public async health() {
    try {
      // Check Bitcoin RPC connection
      const miningInfo = await this.bitcoinRpcService.getMiningInfo();
      const bitcoinStatus = miningInfo ? 'connected' : 'disconnected';

      // Check database connection (via a simple query)
      const clients = await this.clientService.getUserAgents();
      const databaseStatus = clients ? 'connected' : 'disconnected';

      // Check cache connection
      const testKey = '__health_check__';
      await this.cacheManager.set(testKey, 'ok', 1);
      const cacheValue = await this.cacheManager.get(testKey);
      const cacheStatus = cacheValue === 'ok' ? 'connected' : 'disconnected';

      const uptime = Date.now() - this.uptime.getTime();
      const healthy = bitcoinStatus === 'connected' && databaseStatus === 'connected';

      return {
        status: healthy ? 'healthy' : 'degraded',
        version: this.version,
        uptime: uptime,
        uptimeReadable: this.formatDuration(uptime),
        checks: {
          bitcoin: bitcoinStatus,
          database: databaseStatus,
          cache: cacheStatus,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        version: this.version,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
