import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { createClient as createRedisClient, RedisClientType } from 'redis';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { IPeerInfo } from '../models/bitcoin-rpc/IPeerInfo';
import { INetworkInfo } from '../models/bitcoin-rpc/INetworkInfo';
import * as fs from 'node:fs';

/**
 * How the pool learns about new bitcoind blocks. Configurable via
 * `BLOCK_NOTIFY_SOURCE`:
 *
 *   - `zmq`         (default, legacy) — pool process subscribes
 *                    directly to bitcoind's ZMQ feed. Requires the
 *                    Node `zeromq` NAPI binding, which doesn't yet
 *                    run on Bun (oven-sh/bun#18546).
 *   - `redis-pubsub` — pool subscribes to a Redis channel populated
 *                    by an external `zmq-sidecar` process. Runtime-
 *                    agnostic (works on Bun). See `zmq-sidecar/`.
 *   - `polling`     — last-resort fallback. Calls `getmininginfo`
 *                    every 500 ms. ~250 ms median block-detection
 *                    latency hit vs ZMQ.
 *
 * The downstream effect (pollMiningInfo → newBlock$) is identical
 * across all three sources; only the trigger differs.
 */
type BlockNotifySource = 'zmq' | 'redis-pubsub' | 'polling';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHeight = 0;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {
        const url = this.configService.get('BITCOIN_RPC_URL');
        let user = this.configService.get('BITCOIN_RPC_USER');
        let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE')

        if (cookiefile != undefined && cookiefile != '') {
            const cookie = fs.readFileSync(cookiefile).toString().split(':')

            user = cookie[0]
            pass = cookie[1]
        }

        this.client = new RPCClient({ url, port, timeout, user, pass });

        this.client.getrpcinfo().then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });

        const source = this.resolveBlockNotifySource();
        switch (source) {
            case 'redis-pubsub':
                await this.startRedisPubSubListener();
                await this.pollMiningInfo();
                break;
            case 'zmq':
                await this.startZmqListener();
                await this.pollMiningInfo();
                break;
            case 'polling':
            default:
                console.log('[BitcoinRpc] block notify source: polling (every 500ms)');
                setInterval(this.pollMiningInfo.bind(this), 500);
                break;
        }
    }

    /**
     * Decide which notification source to use, with backwards-compatible
     * defaults: if `BLOCK_NOTIFY_SOURCE` is unset, we keep the legacy
     * behaviour — ZMQ when `BITCOIN_ZMQ_HOST` is configured, polling
     * otherwise. Explicit `BLOCK_NOTIFY_SOURCE` overrides this.
     */
    private resolveBlockNotifySource(): BlockNotifySource {
        const explicit = this.configService.get<string>('BLOCK_NOTIFY_SOURCE')?.trim()?.toLowerCase();
        if (explicit === 'redis-pubsub' || explicit === 'redis' || explicit === 'pubsub') return 'redis-pubsub';
        if (explicit === 'zmq') return 'zmq';
        if (explicit === 'polling' || explicit === 'poll') return 'polling';
        // Legacy auto-detect
        return this.configService.get('BITCOIN_ZMQ_HOST') ? 'zmq' : 'polling';
    }

    private async startZmqListener(): Promise<void> {
        // Lazy import — keeps the `zeromq` NAPI binding from loading on
        // runtimes where it crashes (e.g. Bun, see oven-sh/bun#18546).
        // Pool can still boot in 'redis-pubsub' or 'polling' mode without
        // ever touching zeromq.
        const zmq = await import('zeromq');
        console.log('[BitcoinRpc] block notify source: ZMQ (direct subscribe)');
        const sock = new zmq.Subscriber;

        sock.connectTimeout = 1000;
        sock.events.on('connect', () => console.log('[BitcoinRpc] ZMQ connected'));
        sock.events.on('connect:retry', () => console.log('[BitcoinRpc] ZMQ retrying connect'));

        sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
        sock.subscribe('rawblock');
        // Don't await — would block the rest of onModuleInit
        this.listenForNewBlocksZmq(sock);
    }

    private async listenForNewBlocksZmq(sock: any) {
        for await (const [, _msg] of sock) {
            console.log('[BitcoinRpc] new block (via ZMQ)');
            await this.pollMiningInfo();
        }
    }

    private async startRedisPubSubListener(): Promise<void> {
        const channel = this.configService.get<string>('BLOCK_NOTIFY_CHANNEL')?.trim() ?? 'pool:bitcoind:newblock';
        const host = this.configService.get<string>('REDIS_HOST')?.trim();
        const port = parseInt(this.configService.get<string>('REDIS_PORT') ?? '6379', 10);
        const password = this.configService.get<string>('REDIS_PASSWORD')?.trim() || undefined;

        if (!host) {
            console.error('[BitcoinRpc] BLOCK_NOTIFY_SOURCE=redis-pubsub but REDIS_HOST is unset — falling back to polling');
            setInterval(this.pollMiningInfo.bind(this), 500);
            return;
        }

        console.log(`[BitcoinRpc] block notify source: Redis pub/sub (channel: ${channel})`);

        const url = `redis://${password ? `:${password}@` : ''}${host}:${port}`;
        const sub = createRedisClient({ url }) as RedisClientType;
        sub.on('error', (e: Error) => console.error('[BitcoinRpc] Redis pub/sub error:', e.message));
        sub.on('reconnecting', () => console.log('[BitcoinRpc] Redis pub/sub reconnecting'));
        sub.on('ready', () => console.log('[BitcoinRpc] Redis pub/sub ready'));
        await sub.connect();

        await sub.subscribe(channel, async (hash: string) => {
            console.log(`[BitcoinRpc] new block (via Redis pub/sub): ${hash.slice(0, 16)}…`);
            await this.pollMiningInfo();
        });

        // Heartbeat watchdog — warn if the sidecar stops publishing for >90s.
        // Helpful prod observability; loss of heartbeat = ZMQ subscription
        // probably hung, which would silently stall job dispatch.
        const heartbeatChannel = `${channel}:heartbeat`;
        let lastHeartbeatAt = Date.now();
        await sub.subscribe(heartbeatChannel, () => { lastHeartbeatAt = Date.now(); });
        setInterval(() => {
            const since = Date.now() - lastHeartbeatAt;
            if (since > 90_000) {
                console.warn(`[BitcoinRpc] no ZMQ-sidecar heartbeat for ${Math.round(since / 1000)}s — block notifications may be stalled`);
            }
        }, 30_000).unref();
    }

    public getBlockHeight(): number {
        return this.blockHeight;
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
            console.log("block height change");
            this._newBlock$.next(miningInfo);
            this.blockHeight = miningInfo.blocks;
        }
    }

    public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
        try {
            const result = await this.loadBlockTemplate(blockHeight);
            console.log(`getblocktemplate tx count: ${result.transactions.length}`);
            return result;
        } catch (e) {
            console.error('Error getblocktemplate:', e.message);
            throw new Error('Error getblocktemplate');
        }
    }

    private async loadBlockTemplate(blockHeight: number) {

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            blockTemplate = await this.client.getblocktemplate({
                template_request: {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal']
                }
            });
        }


        await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.client.getmininginfo();
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async getPeerInfo(): Promise<IPeerInfo[]> {
        try {
            return await this.client.getpeerinfo();
        } catch (e) {
            console.error('Error getpeerinfo', e.message);
            return null;
        }
    }

    public async getNetworkInfo(): Promise<INetworkInfo> {
        try {
            return await this.client.getnetworkinfo();
        } catch (e) {
            console.error('Error getnetworkinfo', e.message);
            return null;
        }
    }

    public async getRawMempool(): Promise<string[]> {
        try {
            return await this.client.getrawmempool();
        } catch (e) {
            console.error('Error getrawmempool', e.message);
            return [];
        }
    }

    public async getRawMempoolWtxids(): Promise<Set<string>> {
        try {
            const verbose = await this.client.getrawmempool({ verbose: true });
            const wtxids = new Set<string>();
            for (const txid of Object.keys(verbose)) {
                const entry = verbose[txid];
                wtxids.add(entry.wtxid || txid);
            }
            return wtxids;
        } catch (e) {
            console.error('Error getrawmempool verbose', e.message);
            return new Set();
        }
    }

    public async getRawTransaction(txid: string): Promise<string | null> {
        try {
            return await this.client.getrawtransaction({ txid });
        } catch (e) {
            console.error('Error getrawtransaction:', e.message);
            return null;
        }
    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.client.submitblock({
                hexdata
            });
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e;
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }
}

