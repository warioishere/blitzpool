import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { getAddressInfo } from 'bitcoin-address-validation';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { recordConnectionFailure } from '../services/protocol-detector.service';
import { normalizeBtcAddress } from '../utils/btc-address.utils';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode, STRATUM_REJECT_STALE } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { PoolShareStatisticsService } from '../ORM/pool-share-statistics/pool-share-statistics.service';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { StratumV1Service } from '../services/stratum-v1.service';
import { ClientDifficultyStatisticsService } from '../ORM/client-difficulty-statistics/client-difficulty-statistics.service';
import { ShareTotalsCacheService } from '../services/share-totals-cache.service';
import { AddressSettingsCacheService } from '../services/address-settings-cache.service';
import { PplnsService } from '../services/pplns.service';
import { GroupSoloService } from '../services/group-solo.service';
import { MinerActiveModeService } from '../services/miner-active-mode.service';
import { PoolModeHashrateService } from '../ORM/pool-mode-hashrate/pool-mode-hashrate.service';
import { PayoutMode } from './interfaces/unified-stratum.interfaces';


/**
 * ckpool-style per-job difficulty clamp (stratifier.c:6200-6205, comment
 * preserved): when a vardiff ratchet bumps the session difficulty up,
 * miner firmware typically only applies the new target on the *next*
 * `mining.notify` it receives — shares for jobs already in flight were
 * legitimately computed against the OLD target. Without this clamp those
 * shares get rejected as "Difficulty too low" even though the miner did
 * exactly what we told it to do. Pool's response: accept & credit such
 * shares against the OLD diff (or the new one, whichever is lower).
 *
 * `jobIdInt` is `parseInt(job.jobId, 16)` — the SV1 jobs service hands
 * out monotonic integers serialized as hex (stratum-v1-jobs.service.ts:
 * 187), so a numeric `<` is safe.
 *
 * Returns the difficulty to use for BOTH the validation `>=` check AND
 * downstream accounting (PPLNS recordShare, group-solo recordShare,
 * per-mode hashrate, share totals). Keeping these in lock-step prevents
 * the miner from getting credit at the post-ratchet diff for work they
 * actually did at the pre-ratchet diff.
 */
export function effectiveJobDifficulty(
    jobIdInt: number,
    currentDiff: number,
    oldDiff: number,
    diffChangeJobId: number | null,
): number {
    if (diffChangeJobId == null || !Number.isFinite(jobIdInt)) {
        return currentDiff;
    }
    if (jobIdInt < diffChangeJobId) {
        return Math.min(currentDiff, oldDiff);
    }
    return currentDiff;
}


export class StratumV1Client {

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timer[] = [];

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private readonly initialDifficulty: number;
    private sessionDifficulty: number;
    private pendingSessionDifficulty: number | null = null;
    // ckpool-style vardiff race window state (see effectiveJobDifficulty
    // above). Both fields advance only inside checkDifficulty(); reading
    // them needs no locking because share validation runs on the same
    // event-loop turn as the ratchet.
    private oldSessionDifficulty: number;
    private diffChangeJobId: number | null = null;
    private deviceOnlineNotified = false;
    private deviceOfflineNotified = false;

    private entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public sessionId: string;
    public extraNonce: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    private buffer: string = '';

    private miningSubmissionHashes = new Set<string>()

    private network: bitcoinjs.networks.Network;

    private subscribeResponse?: string;
    private authorizeResponse?: string;
    private difficultyCheckIntervalMs: number;
    private lastDifficultyCheck = 0;

    /**
     * Accepted-share counter for the payout-mode warmup gate. Shares
     * 1..ledgerWarmupShares from a fresh session are validated but
     * intentionally skip the PPLNS / group-solo ledger write — filters
     * CPU miners that briefly reach the minimum diff but can't sustain
     * a stream of shares. Not an address-level counter on purpose:
     * every reconnect restarts warmup, which matches our intent (a
     * miner that can't stay connected long enough to clear 10 shares
     * isn't contributing meaningfully either).
     */
    private acceptedShareCount = 0;

    // Handshake timing monitoring
    private handshakeStartTime: number;
    private subscribeReceivedTime: number;
    private authorizeReceivedTime: number;
    private initializeStartTime: number;
    private firstJobSentTime: number;
    private jobSubscriptionTime: number;

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly addressSettingsCacheService: AddressSettingsCacheService,
        private readonly poolShareStatisticsService: PoolShareStatisticsService,
        private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly clientDifficultyStatisticsService: ClientDifficultyStatisticsService,
        private readonly shareTotalsCacheService: ShareTotalsCacheService,
        private readonly stratumV1Service: StratumV1Service,
        initialDifficulty: number,
        private readonly allowSuggestedDifficulty: boolean = true,
        private readonly targetSharesPerMinute: number = 6,
        private readonly redisClient?: any,
        private readonly payoutMode: PayoutMode = 'solo',
        private readonly pplnsService?: PplnsService,
        private readonly groupSoloService?: GroupSoloService,
        private readonly minerActiveModeService?: MinerActiveModeService,
        private readonly poolModeHashrateService?: PoolModeHashrateService,
        /** VarDiff floor passed through from StratumPortConfig. */
        private readonly minimumDifficulty: number = 0,
        /**
         * Per-session warmup gate: shares 1..N-1 are validated but not
         * recorded in the PPLNS / group-solo ledger. See the PPLNS port
         * config comment in protocol-detector.service.ts for rationale.
         */
        private readonly ledgerWarmupShares: number = 0,
    ) {
        const rawInitial = Number.isFinite(initialDifficulty) ? initialDifficulty : 16384;
        // Clamp to the port's minimum: a PPLNS connection that somehow
        // picks up a lower suggested-difficulty would otherwise get
        // dropped straight below the floor.
        this.initialDifficulty = this.minimumDifficulty > 0
            ? Math.max(rawInitial, this.minimumDifficulty)
            : rawInitial;
        this.sessionDifficulty = this.initialDifficulty;
        this.oldSessionDifficulty = this.initialDifficulty;
        this.pendingSessionDifficulty = this.sessionDifficulty;

        const networkConfig = this.configService.get('NETWORK');
        if (networkConfig === 'mainnet') {
            this.network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'testnet') {
            this.network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'regtest') {
            this.network = bitcoinjs.networks.regtest;
        } else {
            throw new Error('Invalid network configuration');
        }

        const parsed = parseInt(this.configService.get('DIFFICULTY_CHECK_INTERVAL_MS') ?? '60000');
        this.difficultyCheckIntervalMs = isNaN(parsed) ? 60000 : parsed;

        // Initialize handshake timing
        this.handshakeStartTime = Date.now();

        this.socket.on('data', (data: string) => {
            this.buffer += data;
            let lines = this.buffer.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

            (async () => {
                for (const m of lines.filter(l => l.length > 0)) {
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        await this.socket.end();
                        console.error(e);
                    }
                }
            })()
        });


    }

    public get address(): string | undefined {
        return this.clientAuthorization?.address;
    }

    public getCurrentDifficulty(): number | undefined {
        if (!this.sessionId) {
            return undefined;
        }

        return this.sessionDifficulty;
    }

    public getSubmissionCacheForInterval(startTime: Date, endTime: Date): Array<{time: Date, difficulty: number}> {
        if (!this.statistics) return [];

        // Access private submissionCache via bracket notation
        const cache = this.statistics['submissionCache'] as Array<{time: Date, difficulty: number}>;
        if (!cache) return [];

        // Filter to only submissions within the time range
        return cache.filter(sub =>
            sub.time >= startTime && sub.time < endTime
        );
    }

    public resetBestDifficulty(): void {
        if (this.entity) {
            this.entity.bestDifficulty = 0;
        }
    }

    public async destroy() {

        if (this.clientAuthorization && this.deviceOnlineNotified && !this.deviceOfflineNotified) {
            this.deviceOfflineNotified = true;
            try {
                await this.notificationService.notifyDeviceStatusChange({
                    address: this.clientAuthorization.address,
                    workerName: this.clientAuthorization.worker,
                    userAgent: this.entity?.userAgent ?? this.clientSubscription?.userAgent,
                    sessionId: this.entity?.sessionId ?? this.sessionId,
                    isOnline: false,
                    timestamp: new Date(),
                });
            } catch (err) {
                console.error('Failed to notify device offline status', err);
            }
        }

        const sid = this.entity?.sessionId || this.sessionId;
        if (sid) {
            await this.clientService.delete(sid);
        }

        if (this.clientAuthorization) {
            this.stratumV1Service.unregisterClient(this.clientAuthorization.address, this);
        }

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach(work => {
            clearInterval(work);
        });

        // Remove all socket listeners to prevent memory leaks —
        // closures capture `this` and keep the entire client object alive
        this.socket.removeAllListeners();
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }

    private trackSessionDifficultyChange() {
        if (!Number.isFinite(this.sessionDifficulty)) {
            this.pendingSessionDifficulty = null;
            return;
        }

        this.pendingSessionDifficulty = this.sessionDifficulty;
    }

    private async persistSessionDifficultyIfPossible() {
        if (!this.entity || this.pendingSessionDifficulty == null) {
            return;
        }

        const difficulty = this.pendingSessionDifficulty;
        try {
            await this.clientService.updateCurrentDifficulty(this.entity.sessionId, difficulty);
            this.pendingSessionDifficulty = null;
            this.entity.currentDifficulty = difficulty;
        } catch (error) {
            console.error('Failed to persist current difficulty', error);
        }
    }

    private async recordSessionDifficulty(): Promise<void> {
        this.trackSessionDifficultyChange();
        await this.persistSessionDifficultyIfPossible();
    }


    // Fast validation functions (replacing class-validator for performance)
    private isValidSubscription(msg: any): boolean {
        // SV1 spec: params is OPTIONAL. When present, params[0] is the
        // user-agent string. Bare-minimum compliant clients (e.g. the
        // Braiins Hashpower marketplace prober) send `params: []`.
        // Requiring length >= 1 rejected those probes with
        // "Subscription validation error", which Braiins surfaced as
        // bid status PAUSED, last_pause_reason: "target does not
        // accept hashing power or it is not compatible".
        return msg.id != null &&
               msg.method === 'mining.subscribe' &&
               Array.isArray(msg.params);
    }

    private isValidConfiguration(msg: any): boolean {
        return msg.id != null &&
               msg.method === 'mining.configure' &&
               Array.isArray(msg.params);
    }

    private isValidAuthorization(msg: any): boolean {
        return msg.id != null &&
               msg.method === 'mining.authorize' &&
               Array.isArray(msg.params) &&
               msg.params.length >= 2 &&
               typeof msg.params[0] === 'string'; // address.worker format
    }

    private isValidSuggestDifficulty(msg: any): boolean {
        return msg.id != null &&
               msg.method === 'mining.suggest_difficulty' &&
               Array.isArray(msg.params) &&
               msg.params.length >= 1 &&
               typeof msg.params[0] === 'number' &&
               msg.params[0] > 0;
    }

    private isValidMiningSubmit(msg: any): boolean {
        return msg.id != null &&
               msg.method === 'mining.submit' &&
               Array.isArray(msg.params) &&
               msg.params.length >= 5 &&
               typeof msg.params[0] === 'string' && // worker
               typeof msg.params[1] === 'string' && // jobId
               typeof msg.params[2] === 'string' && // extraNonce2
               typeof msg.params[3] === 'string' && // ntime
               typeof msg.params[4] === 'string';   // nonce
    }

    private async handleMessage(message: string) {
        //console.log(`Received from ${this.sessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            //console.log("Invalid JSON");
            await this.socket.end();
            return;
        }



        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                // Use fast validation instead of class-validator
                if (!this.isValidSubscription(parsedMessage)) {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid subscription message').response();
                    await this.write(err);
                    break;
                }

                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                {

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(
                            this.targetSharesPerMinute,
                            this.minimumDifficulty,
                        );
                        this.sessionId = this.getRandomHexString();
                        this.extraNonce = this.sessionId;
                        console.log(`New client ID: : ${this.sessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`);

                        // Handshake monitoring: subscribe received
                        this.subscribeReceivedTime = Date.now();
                    }

                    this.clientSubscription = subscriptionMessage;
                    this.subscribeResponse = JSON.stringify(this.clientSubscription.response(this.sessionId, this.extraNonce)) + '\n';
                    await this.write(this.subscribeResponse);

                    // ckpool-style: send mining.set_difficulty +
                    // first mining.notify IMMEDIATELY after the
                    // subscribe response. No 15 ms timer wait, no
                    // gating on mining.extranonce.subscribe / authorize.
                    //
                    // Why we changed away from the deferred-init path:
                    // commit 366f496 introduced the timer to give
                    // mining.extranonce.subscribe a chance to land
                    // before the first mining.notify, avoiding one
                    // wasted job for miners that opt into XNSub. In
                    // practice that optimisation breaks spec-compliant
                    // probers (Braiins Hashpower marketplace upstream
                    // check, stratum-speed-test, …) — they tear the
                    // connection down on a tight deadline if they
                    // don't see set_difficulty + notify quickly.
                    //
                    // ckpool — battle-tested reference SV1 pool —
                    // sends both messages immediately after subscribe
                    // and doesn't even support mining.extranonce.subscribe.
                    // For miners that do send it, our existing
                    // EXTRANONCE_SUBSCRIBE post-init handler re-sends
                    // mining.set_extranonce and a fresh mining.notify
                    // with clearJobs=true; the miner discards the
                    // microseconds-old first job and mines on the
                    // extranonce-aware one. SV1-compliant.
                    if (!this.stratumInitialized) {
                        await this.flushInit();
                    }
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {
                // Use fast validation instead of class-validator
                if (!this.isValidConfiguration(parsedMessage)) {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid configuration message').response();
                    await this.write(err);
                    break;
                }

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {
                // Use fast validation instead of class-validator
                if (!this.isValidAuthorization(parsedMessage)) {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid authorization message').response();
                    await this.write(err);
                    break;
                }

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                // Trim + normalise bech32 (lowercase) before accepting. Without
                // this, every downstream lookup (PPLNS window aggregate, group
                // routing cache, ledger balance) keys on the user's raw form
                // and fragments work across case variants. See btc-address.utils.
                authorizationMessage.address = normalizeBtcAddress(authorizationMessage.address);

                // Validate Bitcoin address before accepting authorization
                try {
                    getAddressInfo(authorizationMessage.address);
                } catch (error) {
                    console.warn(`[StratumV1Client] Invalid Bitcoin address from ${this.socket.remoteAddress}: ${authorizationMessage.address}`);
                    recordConnectionFailure(this.socket.remoteAddress);
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid Bitcoin address'
                    ).response();
                    await this.write(err);
                    this.socket.destroy();
                    return;
                }

                {
                    this.clientAuthorization = authorizationMessage;

                    // Handshake monitoring: authorize received
                    this.authorizeReceivedTime = Date.now();

                    this.stratumV1Service.registerClient(this.clientAuthorization.address, this);
                    this.authorizeResponse = JSON.stringify(this.clientAuthorization.response()) + '\n';
                    const success = await this.write(this.authorizeResponse);
                    if (!success) {
                        return;
                    }
                    if (this.stratumInitialized) {
                        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
                        await this.sendNewMiningJob(jobTemplate);
                    }

                    // Send device online notification immediately after successful authorization
                    // This ensures notifications are sent even if device disconnects before submitting shares
                    if (!this.deviceOnlineNotified) {
                        this.deviceOnlineNotified = true;
                        this.deviceOfflineNotified = false;

                        // Check if this is a returning device (non-blocking)
                        const startTime = new Date();
                        this.clientService.getFirstSeenIfRecent(
                            this.clientAuthorization.address,
                            this.clientAuthorization.worker
                        ).then(firstSeen => {
                            this.notificationService.notifyDeviceStatusChange({
                                address: this.clientAuthorization.address,
                                workerName: this.clientAuthorization.worker,
                                userAgent: this.clientSubscription?.userAgent,
                                sessionId: this.sessionId,
                                isOnline: true,
                                timestamp: startTime,
                                isReturning: firstSeen !== null,
                            }).catch(err => {
                                console.error('Failed to notify device online status', err);
                            });
                        }).catch(err => {
                            console.error('Failed to check firstSeen for device online notification', err);
                        });
                    }
                }

                break;
            }
            // mining.extranonce.subscribe: dropped, ckpool-style.
            // We assign a fixed extranonce-1 in the subscribe response
            // and never change it — the dynamic-extranonce protocol
            // adds complexity without practical benefit at our scale.
            // Clients that send it get no reply (their request id is
            // dropped); standard ASIC firmware tolerates this and
            // continues mining on the static extranonce-1.
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                // Use fast validation instead of class-validator
                if (!this.isValidSuggestDifficulty(parsedMessage)) {
                    console.error('Suggest difficulty validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid suggest difficulty message').response();
                    await this.write(err);
                    break;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                if (!this.allowSuggestedDifficulty) {
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty is disabled for this connection',
                    ).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    return;
                }

                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                this.clientSuggestedDifficulty = suggestDifficultyMessage;
                // Clamp the client's suggestion to the port's floor. A
                // PPLNS-port connection suggesting diff 64 would otherwise
                // succeed and pollute the ledger with sub-dust shares.
                this.sessionDifficulty = this.minimumDifficulty > 0
                    ? Math.max(suggestDifficultyMessage.suggestedDifficulty, this.minimumDifficulty)
                    : suggestDifficultyMessage.suggestedDifficulty;
                await this.recordSessionDifficulty();
                const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                if (!success) {
                    return;
                }
                this.usedSuggestedDifficulty = true;
                break;
            }
            case eRequestMethod.SUBMIT: {
                // Use fast validation instead of class-validator (CRITICAL for performance)
                if (!this.isValidMiningSubmit(parsedMessage)) {
                    console.log('Mining Submit validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid mining submit message').response();
                    await this.write(err);
                    break;
                }

                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                if (this.stratumInitialized && this.clientAuthorization) {
                    await this.handleMiningSubmission(miningSubmitMessage);
                } else if (!this.clientAuthorization) {
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.UnauthorizedWorker,
                        'Unauthorized worker').response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                } else if (!this.stratumInitialized) {
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.NotSubscribed,
                        'Not subscribed').response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
            // default: {
            //     console.log("Invalid message");
            //     console.log(parsedMessage);
            //     await this.socket.end();
            //     return;
            // }
        }


    }

    /**
     * ckpool-style init: send mining.set_difficulty + first
     * mining.notify immediately. Idempotent — early-returns if
     * already initialised. Called from the SUBSCRIBE handler after
     * we've written the subscribe response.
     */
    private async flushInit() {
        if (this.stratumInitialized) {
            return;
        }
        await this.initStratum();
    }

    private async initStratum() {
        // Handshake monitoring: initialization started
        this.initializeStartTime = Date.now();

        this.stratumInitialized = true;

        const fallbackDifficulty = 0.1;
        let startDifficulty = this.sessionDifficulty;
        const configuredHighDiffStart = parseFloat(
            this.configService.get('STRATUM_HIGH_DIFF_START_DIFFICULTY') ?? '',
        );
        const highDiffStart = Number.isFinite(configuredHighDiffStart)
            ? configuredHighDiffStart
            : 1000000;

        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                if (this.initialDifficulty < highDiffStart) {
                    this.sessionDifficulty = fallbackDifficulty;
                    startDifficulty = this.sessionDifficulty;
                    await this.recordSessionDifficulty();
                }
                break;
            }
        }

        await this.recordSessionDifficulty();

        if (this.clientSuggestedDifficulty == null) {
            const setDifficulty = JSON.stringify(
                new SuggestDifficulty().response(startDifficulty),
            );
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }

        }

        // Handshake monitoring: job subscription starting
        this.jobSubscriptionTime = Date.now();

        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe(async (jobTemplate) => {
            try {
                if(jobTemplate.blockData.clearJobs){
                    this.miningSubmissionHashes.clear();
                }
                await this.sendNewMiningJob(jobTemplate);
            } catch (e) {
                await this.socket.end();
                console.error(e);
            }
        });

        this.backgroundWork.push(
            setInterval(async () => {
                await this.checkDifficulty();
            }, this.difficultyCheckIntervalMs)
        );
    }

    /**
     * Live lookup of the active group-id for this session's address. Returns null
     * if group-solo isn't enabled, the address hasn't been authorized yet, or the
     * address isn't a member of an active group. Called per-share/per-job because
     * membership can change after connect (miner added to group while connected).
     */
    private activeGroupId(): string | null {
        if (!this.groupSoloService?.isEnabled()) return null;
        const address = this.clientAuthorization?.address;
        if (!address) return null;
        const entry = this.groupSoloService.getGroupForAddress(address);
        return entry?.active ? entry.groupId : null;
    }

    /**
     * Dispatch a rejected share to group-solo if the miner is currently in an
     * active group AND not connected on the PPLNS port. A miner who deliberately
     * chose the PPLNS port has opted out of group bookkeeping for this session,
     * so their rejects must not inflate the group's reject counter.
     */
    private async dispatchGroupReject(): Promise<void> {
        if (this.payoutMode === 'pplns') return;
        if (!this.activeGroupId()) return;
        await this.groupSoloService!.recordReject(
            this.clientAuthorization.address,
            this.sessionDifficulty,
        );
    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {
        const jobStartTime = Date.now();

        // Block-change clearJobs used to also rotate the extranonce
        // and re-broadcast via mining.set_extranonce when the client
        // had subscribed to dynamic extranonce. We dropped that whole
        // branch (ckpool-style: static extranonce-1 from subscribe
        // response, no dynamic changes), so nothing extra to do here
        // — the next mining.notify with clearJobs=true is enough.

        let payoutInformation;

        if (this.entity && this.clientAuthorization) {
            this.hashRate = this.statistics.hashRate;
        }

        // Routing priority: explicit PPLNS port trumps group membership.
        // If a miner chooses to connect to the PPLNS port, treat that as a
        // deliberate opt-out from their group for this session — otherwise
        // group-address-driven routing would silently hijack their shares
        // back to group-solo even though they asked for PPLNS by port.
        // Reverse order (group first) kept pre-PR for the Solo port, where
        // address-driven group-solo is the whole point of that feature.
        const jobGroupId = this.activeGroupId();
        if (this.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
            // PPLNS: Shared coinbase with proportional payouts
            // Network difficulty is synced centrally via PplnsService's job subscription
            payoutInformation = await this.pplnsService.getPayoutDistribution(jobTemplate.blockData.coinbasevalue);
            this.noFee = false;
            if (!payoutInformation || payoutInformation.length === 0) {
                // No miners in window yet — skip the job rather than build a
                // solo coinbase. Only realistic at pool cold-start or
                // post-Redis-flush; once a share lands the next job builds
                // a real PPLNS distribution. SV2 has the same K4 fix.
                console.warn(
                    `[StratumV1Client] PPLNS window empty — skipping job for ` +
                    `${this.clientAuthorization?.address ?? '<unauth>'}, will retry on next template`,
                );
                return;
            }
        } else if (jobGroupId) {
            // Group-solo on non-PPLNS port: per-miner coinbase, PROP-style
            // split + finder-bonus output to THIS connection's address.
            // Each session's template names them as the bonus recipient,
            // so whoever finds the block has the bonus already in the
            // coinbase. Snapshots are keyed per finderAddress so
            // onBlockFound can match the on-chain split exactly.
            payoutInformation = await this.groupSoloService!.getPayoutDistribution(
                jobGroupId,
                jobTemplate.blockData.coinbasevalue,
                this.clientAuthorization?.address,
            );
            this.noFee = false;
            if (!payoutInformation || payoutInformation.length === 0) return;
        } else {
            // Solo: Existing behavior
            const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
            const devFeePercent = parseFloat(
                this.configService.get('DEV_FEE_PERCENT') ?? '1.5',
            );

            if (!this.clientAuthorization) {
                if (!devFeeAddress) {
                    return;
                }
                this.noFee = false;
                payoutInformation = [
                    { address: devFeeAddress, percent: 100 },
                ];
            } else {
                this.noFee = devFeeAddress == null || devFeeAddress.length < 1;
                if (this.noFee) {
                    payoutInformation = [
                        { address: this.clientAuthorization.address, percent: 100 },
                    ];
                } else {
                    payoutInformation = [
                        { address: devFeeAddress, percent: devFeePercent },
                        {
                            address: this.clientAuthorization.address,
                            percent: 100 - devFeePercent,
                        },
                    ];
                }
            }
        }

        const network = this.network;
        const beforeJobCreation = Date.now();

        const job = new MiningJob(
            this.configService,
            network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate
        );

        const afterJobCreation = Date.now();
        const jobCreationTime = afterJobCreation - beforeJobCreation;

        this.stratumV1JobsService.addJob(job);
        const afterAddJob = Date.now();
        const addJobTime = afterAddJob - afterJobCreation;

        const beforeSocketWrite = Date.now();
        const success = await this.write(job.response(jobTemplate));
        const afterSocketWrite = Date.now();
        const socketWriteTime = afterSocketWrite - beforeSocketWrite;

        if (!success) {
            return;
        }

        // Handshake monitoring: first job sent with detailed breakdown
        if (!this.firstJobSentTime && this.stratumInitialized) {
            this.firstJobSentTime = Date.now();
        }

        //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.sessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        if (this.entity == null) {
            if (this.creatingEntity == null) {
                this.creatingEntity = new Promise(async (resolve, reject) => {
                    try {
                        const firstSeen = await this.clientService.getFirstSeenIfRecent(
                            this.clientAuthorization.address,
                            this.clientAuthorization.worker
                        );
                        const startTime = new Date();
                        const firstSeenValue = firstSeen ?? startTime;
                        this.entity = await this.clientService.insert({
                            sessionId: this.sessionId,
                            address: this.clientAuthorization.address,
                            clientName: this.clientAuthorization.worker,
                            userAgent: this.clientSubscription.userAgent,
                            startTime,
                            firstSeen: firstSeenValue,
                            bestDifficulty: 0,
                            currentDifficulty: this.sessionDifficulty,
                        });
                        await this.persistSessionDifficultyIfPossible();
                        // Note: deviceOfflineNotified reset and online notification now handled in authorization handler
                    } catch (e) {
                        reject(e);
                    }
                    resolve();
                });
                await this.creatingEntity;

            } else {
                await this.creatingEntity;
            }
        }

        const submissionHash = submission.hash();
        if(this.miningSubmissionHashes.has(submissionHash)){
            await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.DuplicateShare],
                this.sessionDifficulty
            );
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(
                this.clientAuthorization.address,
                eStratumErrorCode[eStratumErrorCode.DuplicateShare],
                this.sessionDifficulty,
            );
            // Persist rejected share to Redis atomically (stateless service)
            await this.clientStatisticsService.addRejectedShare(
                this.entity,
                eStratumErrorCode[eStratumErrorCode.DuplicateShare],
                this.sessionDifficulty,
            );
            await this.dispatchGroupReject();
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.DuplicateShare,
                'Duplicate share').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }else{
            this.miningSubmissionHashes.add(submissionHash);
        }

        const job = this.stratumV1JobsService.getJobById(submission.jobId);

        // Genuine "no record at all" case: the entry has been GC'd, or the
        // miner is sending garbage. After the ckpool-style retire-then-age
        // refactor this should be ~zero in steady state — only reachable
        // if the miner sat on a jobId for the full 10-minute retention
        // window, or there's a real bug. The stale path below covers the
        // common case of a miner submitting against a recently retired
        // job during the new-block fan-out window.
        if (job == null) {
            await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty
            );
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(
                this.clientAuthorization.address,
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty,
            );
            // Persist rejected share to Redis atomically (stateless service)
            await this.clientStatisticsService.addRejectedShare(
                this.entity,
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty,
            );
            await this.dispatchGroupReject();
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        // ckpool-style stale classification. Three outcomes:
        //   - active                 → fall through to normal validation
        //   - stale-creditable       → fall through; the work was issued by
        //                              us, the miner is just within the
        //                              network-jitter grace window
        //   - stale-rejected         → reject with STRATUM_REJECT_STALE
        //                              counter (NOT JobNotFound). Wire
        //                              code is still 21 because Stratum V1
        //                              has no separate stale code, but
        //                              internal stats see this as a
        //                              distinct failure mode.
        const classification = this.stratumV1JobsService.classifyJobForShare(job);
        if (classification === 'stale-rejected') {
            await this.poolRejectedStatisticsService.addRejectedShare(
                STRATUM_REJECT_STALE,
                this.sessionDifficulty
            );
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(
                this.clientAuthorization.address,
                STRATUM_REJECT_STALE,
                this.sessionDifficulty,
            );
            await this.clientStatisticsService.addRejectedShare(
                this.entity,
                STRATUM_REJECT_STALE,
                this.sessionDifficulty,
            );
            await this.dispatchGroupReject();
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,  // wire code 21 — same code as before, miners agnostic
                'stale').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty
            );
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(
                this.clientAuthorization.address,
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty,
            );
            // Persist rejected share to Redis atomically (stateless service)
            await this.clientStatisticsService.addRejectedShare(
                this.entity,
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty,
            );
            await this.dispatchGroupReject();
            console.warn(`Job template ${job.jobTemplateId} not found for job ${submission.jobId}`);
            delete this.stratumV1JobsService.jobs[submission.jobId];
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        // Hot path: compute only the 80-byte block header for hash
        // validation. Skipping the full `Block` clone + `transactions.map`
        // saves ~3000 object allocations per share at production block
        // density. See `MiningJob.computeShareHeader` for the invariant
        // pinned against `copyAndUpdateBlock(...).toBuffer(true)`.
        const versionMask = parseInt(submission.versionMask, 16);
        const nonce = parseInt(submission.nonce, 16);
        const extraNonce2 = submission.extraNonce2;
        const ntime = parseInt(submission.ntime, 16);
        const header = job.computeShareHeader(
            jobTemplate,
            versionMask,
            nonce,
            this.extraNonce,
            extraNonce2,
            ntime,
        );
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);

        // ckpool-style per-job clamp: a share for a job that predates the
        // most recent vardiff ratchet is evaluated against MIN(current,
        // old) — both for the >= validation AND for accounting, so the
        // miner gets credit for exactly the work the job target asked
        // for. Reject paths below intentionally still log against
        // sessionDifficulty (current operational state).
        const submittedJobIdInt = parseInt(submission.jobId, 16);
        const effectiveDiff = effectiveJobDifficulty(
            submittedJobIdInt,
            this.sessionDifficulty,
            this.oldSessionDifficulty,
            this.diffChangeJobId,
        );

        //console.log(`DIFF: ${submissionDifficulty} of ${effectiveDiff} from ${this.clientAuthorization.worker + '.' + this.sessionId}`);

        // Exact accept/reject: compare the share's hash directly against the
        // target the miner was given. Avoids the float-precision boundary
        // where a share hitting target T round-trips to a recomputed
        // difficulty marginally below the assigned diff. submissionDifficulty
        // is still used below for block-detection (network-diff is far above
        // the boundary so float is fine there).
        const effectiveTarget = DifficultyUtils.difficultyToTarget(effectiveDiff);
        if (DifficultyUtils.meetsTarget(hashBuffer, effectiveTarget)) {
            // Send success response immediately for minimum latency
            this.write(JSON.stringify(submission.response()) + '\n');

            // Accounting and block submission below — all fully awaited, nothing skipped
            await this.poolShareStatisticsService.addAcceptedShare(effectiveDiff);

            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                // ckpool-style: a possible block-solve is ALWAYS submitted to
                // bitcoind, even for shares against retired/stale templates
                // (stratifier.c:6191-6195 "Make sure we always submit any
                // possible block solve"). bitcoind authoritatively decides
                // validity — a stale-creditable hit during a reorg could
                // still be a valid alternative tip. The block-bookkeeping
                // (`blocksService.save`, push notification, PPLNS payout
                // distribution) is gated on `result === 'SUCCESS!'` below
                // so a rejected block does NOT write a phantom row to
                // `blocks_entity` or push a "block found" notification.
                console.log('!!! BLOCK FOUND !!!');
                // Block-found path is rare (~once per ~10h on this pool size)
                // — build the full Block now, only when actually needed.
                const updatedJobBlock = job.copyAndUpdateBlock(
                    jobTemplate, versionMask, nonce, this.extraNonce, extraNonce2, ntime,
                );
                const blockHex = updatedJobBlock.toHex(false);
                const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);

                if (result !== 'SUCCESS!') {
                    // bitcoind rejected (bad-prevblk for a stale tip,
                    // duplicate from a race, or RPC error). Log and skip
                    // the bookkeeping. Work-credit for the share itself
                    // already happened above and stays — the miner did
                    // the work, they get paid for it, regardless of
                    // whether their block found a home.
                    console.warn(`[Block submit rejected at height ${jobTemplate.blockData.height}]: ${result}`);
                } else {
                    await this.blocksService.save({
                        height: jobTemplate.blockData.height,
                        minerAddress: this.clientAuthorization.address,
                        worker: this.clientAuthorization.worker,
                        sessionId: this.entity.sessionId,
                        blockData: blockHex
                    });

                    await this.notificationService.notifySubscribersBlockFound(
                        this.clientAuthorization.address,
                        jobTemplate.blockData.height,
                        updatedJobBlock,
                        result,
                    );

                    await this.addressSettingsService.resetBestDifficultyAndShares();
                    await this.addressSettingsCacheService.clear();

                    // Route block-found bookkeeping the same way the coinbase
                    // was built — PPLNS port overrides group membership.
                    const foundGroupId = this.activeGroupId();
                    if (this.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
                        await this.pplnsService.onBlockFound(
                            jobTemplate.blockData.height,
                            jobTemplate.blockData.coinbasevalue,
                        );
                    } else if (foundGroupId) {
                        await this.groupSoloService!.onBlockFound(
                            jobTemplate.blockData.height,
                            jobTemplate.blockData.coinbasevalue,
                            this.clientAuthorization.address,
                        );
                    }
                }
            }
            try {
                // Update live hashrate calculation
                this.statistics.updateHashRate(effectiveDiff);

                // Persist to Redis atomically (stateless service)
                await this.clientStatisticsService.addAcceptedShare(this.entity, effectiveDiff);

                // Record share — PPLNS port overrides group membership, matching
                // the coinbase-build + block-found routing above. After the
                // routing decision, write a Redis port-marker so
                // /api/pplns/mode/:address reflects the port the miner is
                // ACTUALLY on right now. Marker has a 5-min TTL and is
                // refreshed every share.
                //
                // PPLNS warmup gate: first `ledgerWarmupShares` shares
                // of a fresh session are validated + counted in client
                // stats, but skip the PPLNS ledger. CPU / low-GHz
                // miners that briefly reach the minimum diff don't
                // sustain enough shares to clear the gate. Gate applies
                // ONLY to the PPLNS port — group-solo miners record
                // every share (no min-diff / warmup configured there).
                this.acceptedShareCount++;
                const shareGroupId = this.activeGroupId();
                let effectiveMode: 'solo' | 'pplns' | 'group-solo';
                if (this.payoutMode === 'pplns' && this.pplnsService?.isEnabled()) {
                    const warmupCleared = this.acceptedShareCount > this.ledgerWarmupShares;
                    if (warmupCleared) {
                        await this.pplnsService.recordShare(
                            this.clientAuthorization.address,
                            effectiveDiff,
                        );
                    }
                    effectiveMode = 'pplns';
                } else if (shareGroupId) {
                    await this.groupSoloService!.recordShare(
                        this.clientAuthorization.address,
                        effectiveDiff,
                    );
                    effectiveMode = 'group-solo';
                } else {
                    // Pure solo — no payout-service, but still tagged so
                    // the per-mode hashrate aggregate stays complete.
                    effectiveMode = 'solo';
                }
                await this.minerActiveModeService?.mark(this.clientAuthorization.address, effectiveMode);
                await this.poolModeHashrateService?.incrementAccepted(effectiveMode, effectiveDiff);

                this.shareTotalsCacheService.increment(
                    this.clientAuthorization.address,
                    this.clientAuthorization.worker,
                    effectiveDiff,
                );
                const now = new Date();
                // only update every minute
                if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60) {
                    await this.clientService.heartbeat(
                        this.entity.address,
                        this.entity.clientName,
                        this.entity.sessionId,
                        this.hashRate,
                        now,
                        this.sessionDifficulty,
                    );
                    this.entity.updatedAt = now;
                }

                await this.clientDifficultyStatisticsService.recordShareDifficulty({
                    address: this.clientAuthorization.address,
                    clientName: this.clientAuthorization.worker,
                    timestamp: now.getTime(),
                    difficulty: submissionDifficulty,
                });

                if (now.getTime() - this.lastDifficultyCheck >= this.difficultyCheckIntervalMs) {
                    await this.checkDifficulty();
                }

            } catch (e) {
                console.log(e);
            }

            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficulty(this.entity.sessionId, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
            }

            const shouldUpdateBestDifficulty = await this.addressSettingsCacheService.shouldUpdateBestDifficulty(
                this.clientAuthorization.address,
                submissionDifficulty,
            );

            if (shouldUpdateBestDifficulty) {
                await this.notificationService.notifySubscribersBestDiff(this.clientAuthorization.address, submissionDifficulty);
                await this.addressSettingsService.updateBestDifficulty(this.clientAuthorization.address, submissionDifficulty, this.entity.userAgent);
                await this.addressSettingsCacheService.updateBestDifficulty(
                    this.clientAuthorization.address,
                    submissionDifficulty,
                    this.entity.userAgent ?? null,
                );
            }


            const externalShareSubmissionEnabled: boolean = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() == 'true';
            const minimumDifficulty: number = parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) || 1000000000000.0; // 1T
            if (externalShareSubmissionEnabled && submissionDifficulty >= minimumDifficulty) {
                // Submit share to API if enabled
                this.externalSharesService.submitShare({
                    worker: this.clientAuthorization.worker,
                    address: this.clientAuthorization.address,
                    userAgent: this.clientSubscription.userAgent,
                    header: header.toString('hex'),
                    externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool'
                });
            }

        } else {
            await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.LowDifficultyShare],
                this.sessionDifficulty
            );
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(
                this.clientAuthorization.address,
                eStratumErrorCode[eStratumErrorCode.LowDifficultyShare],
                this.sessionDifficulty,
            );
            // Persist rejected share to Redis atomically (stateless service)
            await this.clientStatisticsService.addRejectedShare(
                this.entity,
                eStratumErrorCode[eStratumErrorCode.LowDifficultyShare],
                this.sessionDifficulty,
            );
            await this.dispatchGroupReject();
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();

            const success = await this.write(err);
            if (!success) {
                return false;
            }

            return false;
        }

        //await this.checkDifficulty();
        return true;

    }

    private async checkDifficulty() {
        this.lastDifficultyCheck = Date.now();
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            //console.log(`Adjusting ${this.sessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            if (!Number.isFinite(targetDiff)) return;
            // Snapshot the boundary BEFORE the ratchet: any job whose id
            // is < the upcoming next-id was issued under the old diff.
            // getNextId() returns the current counter value; addJob()
            // bumps it, so this is exactly the id the next sendNewMiningJob
            // call will assign (stratum-v1-jobs.service.ts:185-188).
            this.oldSessionDifficulty = this.sessionDifficulty;
            this.diffChangeJobId = parseInt(this.stratumV1JobsService.getNextId(), 16);
            this.sessionDifficulty = targetDiff;
            await this.recordSessionDifficulty();

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';


            const success = await this.write(data);
            if (!success) {
                return;
            }

            const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            jobTemplate.blockData.clearJobs = true;
            await this.sendNewMiningJob(jobTemplate);

        }
    }

    private async write(message: string): Promise<boolean> {
        try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {

                await new Promise((resolve, reject) => {
                    this.socket.write(message, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(true);
                        }
                    });
                });

                return true;
            } else {
                console.error(`Error: Cannot write to closed or ended socket. ${this.sessionId} ${message}`);
                await this.destroy();
                if (!this.socket.destroyed) {
                    this.socket.destroy();
                }
                return false;
            }
        } catch (error) {
            await this.destroy();
            if (!this.socket.writableEnded) {
                await this.socket.end();
            } else if (!this.socket.destroyed) {
                this.socket.destroy();
            }
            // ECONNRESET / EPIPE / ETIMEDOUT are routine ungraceful-disconnect
            // signals from the miner side (power blip, WiFi drop, miner reboot).
            // Socket is fully cleaned up above; the error is informational only.
            // Prod sees ~225 of these per day — dumping a full Error stack each
            // time drowns out signal in the logs. Compact one-liner for the
            // routine cases, full Error object preserved for anything else.
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
                console.log(`Socket write failed (${code}): ${this.sessionId}`);
            } else {
                console.error(`Error occurred while writing to socket: ${this.sessionId}`, error);
            }
            return false;
        }
    }

}
