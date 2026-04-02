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
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { ExtraNonceSubscribeMessage } from './stratum-messages/ExtraNonceSubscribeMessage';
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
    private extraNonceSubscribed: boolean = false;
    private sentExtraNonce: boolean = false;

    private network: bitcoinjs.networks.Network;

    private subscribeResponse?: string;
    private authorizeResponse?: string;
    private extranonceResponse?: string;
    private initTimer?: NodeJS.Timeout;
    private difficultyCheckIntervalMs: number;
    private lastDifficultyCheck = 0;

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
    ) {
        this.initialDifficulty = Number.isFinite(initialDifficulty)
            ? initialDifficulty
            : 16384;
        this.sessionDifficulty = this.initialDifficulty;
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

        if (this.initTimer) {
            clearTimeout(this.initTimer);
        }

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
        return msg.id != null &&
               msg.method === 'mining.subscribe' &&
               Array.isArray(msg.params) &&
               msg.params.length >= 1;
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

    private isValidExtraNonceSubscribe(msg: any): boolean {
        return msg.id != null &&
               msg.method === 'mining.extranonce.subscribe';
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

                // Trim whitespace from address (common copy-paste error)
                authorizationMessage.address = authorizationMessage.address?.trim();

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
            case eRequestMethod.EXTRANONCE_SUBSCRIBE: {
                // Use fast validation instead of class-validator
                if (!this.isValidExtraNonceSubscribe(parsedMessage)) {
                    console.error('Extranonce subscribe validation error');
                    const err = new StratumErrorMessage(
                        parsedMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Invalid extranonce subscribe message').response();
                    await this.write(err);
                    break;
                }

                const extraNonceMessage = plainToInstance(
                    ExtraNonceSubscribeMessage,
                    parsedMessage,
                );

                {
                    this.extraNonceSubscribed = true;
                    this.extranonceResponse = JSON.stringify(extraNonceMessage.response()) + '\n';

                    if (this.stratumInitialized) {
                        await this.write(this.extranonceResponse);
                        await this.sendSetExtraNonce();
                        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
                        jobTemplate.blockData.clearJobs = true;
                        await this.sendNewMiningJob(jobTemplate);
                    }
                }

                break;
            }
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
                this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
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


        this.checkInit();
    }

    private checkInit() {
        if (this.stratumInitialized) {
            return;
        }

        if (this.clientSubscription) {
            if (this.extraNonceSubscribed && this.extranonceResponse) {
                if (this.initTimer) {
                    clearTimeout(this.initTimer);
                    this.initTimer = undefined;
                }
                this.flushInit(true);
            } else if (!this.initTimer) {
                this.initTimer = setTimeout(() => {
                    this.flushInit(false);
                }, 15);
            }
        }
    }

    private async flushInit(withXNSub: boolean) {
        if (this.stratumInitialized) {
            return;
        }

        if (this.initTimer) {
            clearTimeout(this.initTimer);
            this.initTimer = undefined;
        }

        if (withXNSub && this.extranonceResponse) {
            await this.write(this.extranonceResponse);
            if (!this.sentExtraNonce) {
                await this.sendSetExtraNonce();
            }
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

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {
        const jobStartTime = Date.now();

        if (jobTemplate.blockData.clearJobs && this.extraNonceSubscribed) {
            this.extraNonce = this.getRandomHexString();
            await this.sendSetExtraNonce();
        }

        let payoutInformation;
        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        const devFeePercent = parseFloat(
            this.configService.get('DEV_FEE_PERCENT') ?? '1.5',
        );

        if (this.entity && this.clientAuthorization) {
            this.hashRate = this.statistics.hashRate;
        }

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
            const accepted = await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.DuplicateShare],
                this.sessionDifficulty
            );
            if (accepted) {
                await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            }
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

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
        if (job == null) {
            const accepted = await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty
            );
            if (accepted) {
                await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            }
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
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            const accepted = await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.JobNotFound],
                this.sessionDifficulty
            );
            if (accepted) {
                await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            }
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

        const updatedJobBlock = job.copyAndUpdateBlock(
            jobTemplate,
            parseInt(submission.versionMask, 16),
            parseInt(submission.nonce, 16),
            this.extraNonce,
            submission.extraNonce2,
            parseInt(submission.ntime, 16)
        );
        const header = updatedJobBlock.toBuffer(true);
        const { submissionDifficulty } = DifficultyUtils.calculateDifficulty(header);

        //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.sessionId}`);


        if (submissionDifficulty >= this.sessionDifficulty) {
            // Send success response immediately for minimum latency
            this.write(JSON.stringify(submission.response()) + '\n');

            // Accounting and block submission below — all fully awaited, nothing skipped
            await this.poolShareStatisticsService.addAcceptedShare(this.sessionDifficulty);

            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                console.log('!!! BLOCK FOUND !!!');
                const blockHex = updatedJobBlock.toHex(false);
                const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
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
                //success
                if (result === 'SUCCESS!') {
                    await this.addressSettingsService.resetBestDifficultyAndShares();
                    await this.addressSettingsCacheService.clear();
                }
            }
            try {
                // Update live hashrate calculation
                this.statistics.updateHashRate(this.sessionDifficulty);

                // Persist to Redis atomically (stateless service)
                await this.clientStatisticsService.addAcceptedShare(this.entity, this.sessionDifficulty);

                this.shareTotalsCacheService.increment(
                    this.clientAuthorization.address,
                    this.clientAuthorization.worker,
                    this.sessionDifficulty,
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
            const accepted = await this.poolRejectedStatisticsService.addRejectedShare(
                eStratumErrorCode[eStratumErrorCode.LowDifficultyShare],
                this.sessionDifficulty
            );
            if (accepted) {
                await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            }
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

    private async sendSetExtraNonce() {
        const data = JSON.stringify({
            id: null,
            method: eResponseMethod.SET_EXTRANONCE,
            params: [this.extraNonce, 4]
        }) + '\n';
        await this.write(data);
        this.sentExtraNonce = true;
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
            console.error(`Error occurred while writing to socket: ${this.sessionId}`, error);
            return false;
        }
    }

}
