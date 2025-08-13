import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';
import { clearInterval } from 'timers';

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

const NETWORKS: Record<string, bitcoinjs.Network> = {
    mainnet: bitcoinjs.networks.bitcoin,
    testnet: bitcoinjs.networks.testnet,
    regtest: bitcoinjs.networks.regtest,
};

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
    private sessionDifficulty: number = 16384;

    private entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    private buffer: string = '';

    private miningSubmissionHashes = new Set<string>();
    private extraNonceSubscribed: boolean = false;
    private sentExtraNonce: boolean = false;

    private network: bitcoinjs.networks.Network;

    private subscribeResponse?: string;
    private authorizeResponse?: string;
    private extranonceResponse?: string;
    private initTimer?: NodeJS.Timeout;
    private difficultyCheckIntervalMs: number;
    private lastDifficultyCheck = 0;

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
        private readonly poolShareStatisticsService: PoolShareStatisticsService,
        private readonly poolRejectedStatisticsService: PoolRejectedStatisticsService,
        private readonly clientRejectedStatisticsService: ClientRejectedStatisticsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly stratumV1Service: StratumV1Service,
    ) {

        const networkConfig = this.configService.get('NETWORK');
        const network = networkConfig ? NETWORKS[networkConfig] : undefined;
        if (!network) {
            throw new Error('Invalid network configuration');
        }
        this.network = network;

        const parsed = parseInt(this.configService.get('DIFFICULTY_CHECK_INTERVAL_MS') ?? '60000');
        this.difficultyCheckIntervalMs = isNaN(parsed) ? 60000 : parsed;

        this.socket.on('data', (data: string) => {
            this.buffer += data;
            let lines = this.buffer.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

            lines
                .filter(m => m.length > 0)
                .forEach(async (m) => {
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        this.socket.end();
                        console.error(e);
                    }
                });
        });


    }

    public get address(): string | undefined {
        return this.clientAuthorization?.address;
    }

    public async destroy() {

        const sid = this.entity?.sessionId || this.extraNonceAndSessionId;
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
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }


    private async handleMessage(message: string) {
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            //console.log("Invalid JSON");
            this.socket.end();
            return;
        }



        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService, this.configService);
                        this.extraNonceAndSessionId = this.getRandomHexString();
                        console.log(`New client ID: : ${this.extraNonceAndSessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`);
                    }

                    this.clientSubscription = subscriptionMessage;
                    this.subscribeResponse = JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId)) + '\n';
                    await this.write(this.subscribeResponse);
                } else {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }

                } else {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;
                    this.authorizeResponse = JSON.stringify(this.clientAuthorization.response()) + '\n';
                    this.stratumV1Service.registerClient(this.clientAuthorization.address, this);
                } else {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.EXTRANONCE_SUBSCRIBE: {
                const extraNonceMessage = plainToInstance(
                    ExtraNonceSubscribeMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(extraNonceMessage, validatorOptions);

                if (errors.length === 0) {
                    this.extraNonceSubscribed = true;
                    this.extranonceResponse = JSON.stringify(extraNonceMessage.response()) + '\n';

                    if (this.stratumInitialized) {
                        await this.write(this.extranonceResponse);
                        await this.sendSetExtraNonce();
                    } else if (this.clientSubscription && this.clientAuthorization) {
                        if (this.initTimer) {
                            clearTimeout(this.initTimer);
                            this.initTimer = undefined;
                        }
                        this.flushInit(true);
                    }
                } else {
                    console.error('Extranonce subscribe validation error');
                    const err = new StratumErrorMessage(
                        extraNonceMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Extranonce subscribe validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {

                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                    const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    if (!success) {
                        return;
                    }
                    this.usedSuggestedDifficulty = true;
                } else {
                    console.error('Suggest difficulty validation error');
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
            case eRequestMethod.SUBMIT: {

                if (this.stratumInitialized == false) {
                    console.log('Submit before initalized');
                    this.socket.end();
                    return;
                }


                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        const success = await this.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                        if (!success) {
                            return;
                        }
                    }


                } else {
                    console.log('Mining Submit validation error');
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    console.error(err);
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
            //     this.socket.end();
            //     return;
            // }
        }


        this.checkInit();
    }

    private checkInit() {
        if (this.stratumInitialized) {
            return;
        }

        if (this.clientSubscription && this.clientAuthorization) {
            if (this.extraNonceSubscribed && this.extranonceResponse) {
                if (this.initTimer) {
                    clearTimeout(this.initTimer);
                    this.initTimer = undefined;
                }
                this.flushInit(true);
            } else if (!this.initTimer) {
                this.initTimer = setTimeout(() => {
                    this.flushInit(false);
                }, 50);
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

        if (this.authorizeResponse) {
            await this.write(this.authorizeResponse);
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
        this.stratumInitialized = true;

        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                this.sessionDifficulty = 0.1;
            }
        }

        if (this.clientSuggestedDifficulty == null) {
            //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
            const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
        }

        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe(async (jobTemplate) => {
            try {
                if(jobTemplate.blockData.clearJobs){
                    this.miningSubmissionHashes.clear();
                }
                await this.sendNewMiningJob(jobTemplate);
            } catch (e) {
                this.socket.end();
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

        if (jobTemplate.blockData.clearJobs && this.extraNonceSubscribed) {
            this.extraNonceAndSessionId = this.getRandomHexString();
            await this.sendSetExtraNonce();

            if (this.entity) {
                const previous = this.entity.sessionId;
                this.entity.sessionId = this.extraNonceAndSessionId;
                await this.clientService.updateSessionId(
                    this.entity.address,
                    this.entity.clientName,
                    previous,
                    this.entity.sessionId,
                );
            }
        }

        let payoutInformation;
        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        const devFeePercent = parseFloat(
            this.configService.get('DEV_FEE_PERCENT') ?? '1.5',
        );

        if (this.entity) {
            this.hashRate = this.statistics.hashRate;
        }

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

        const network = this.network;

        const job = new MiningJob(
            this.configService,
            network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate
        );

        this.stratumV1JobsService.addJob(job);


        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }


        //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)

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
                        this.entity = await this.clientService.insert({
                            sessionId: this.extraNonceAndSessionId,
                            address: this.clientAuthorization.address,
                            clientName: this.clientAuthorization.worker,
                            userAgent: this.clientSubscription.userAgent,
                            startTime: new Date(),
                            firstSeen: firstSeen || new Date(),
                            bestDifficulty: 0
                        });
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
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.poolRejectedStatisticsService.addRejectedShare(eStratumErrorCode[eStratumErrorCode.DuplicateShare], this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(this.clientAuthorization.address, eStratumErrorCode[eStratumErrorCode.DuplicateShare], 1);
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
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.poolRejectedStatisticsService.addRejectedShare(eStratumErrorCode[eStratumErrorCode.JobNotFound], this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(this.clientAuthorization.address, eStratumErrorCode[eStratumErrorCode.JobNotFound], 1);
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
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.poolRejectedStatisticsService.addRejectedShare(eStratumErrorCode[eStratumErrorCode.JobNotFound], this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(this.clientAuthorization.address, eStratumErrorCode[eStratumErrorCode.JobNotFound], 1);
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
            this.extraNonceAndSessionId,
            submission.extraNonce2,
            parseInt(submission.ntime, 16)
        );
        const header = updatedJobBlock.toBuffer(true);
        const { submissionDifficulty } = DifficultyUtils.calculateDifficulty(header);

        //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonceAndSessionId}`);


        if (submissionDifficulty >= this.sessionDifficulty) {
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

                await this.notificationService.notifySubscribersBlockFound(this.clientAuthorization.address, jobTemplate.blockData.height, updatedJobBlock, result);
                //success
                if (result == null) {
                    await this.addressSettingsService.resetBestDifficultyAndShares();
                }
            }
            try {
                await this.statistics.addShares(this.entity, this.sessionDifficulty);
                const now = new Date();
                // only update every minute
                if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60) {
                    await this.clientService.heartbeat(this.entity.address, this.entity.clientName, this.entity.sessionId, this.hashRate, now);
                    this.entity.updatedAt = now;
                }

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

            const addressSettings = await this.addressSettingsService.getSettings(this.clientAuthorization.address, true);
            const storedBestDifficulty = addressSettings?.bestDifficulty ?? 0;

            if (submissionDifficulty > storedBestDifficulty) {
                await this.notificationService.notifySubscribersBestDiff(this.clientAuthorization.address, submissionDifficulty);
                await this.addressSettingsService.updateBestDifficulty(this.clientAuthorization.address, submissionDifficulty, this.entity.userAgent);
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
            await this.poolShareStatisticsService.addRejectedShare(this.sessionDifficulty);
            await this.poolRejectedStatisticsService.addRejectedShare(eStratumErrorCode[eStratumErrorCode.LowDifficultyShare], this.sessionDifficulty);
            await this.clientRejectedStatisticsService.addRejectedShare(this.clientAuthorization.address, eStratumErrorCode[eStratumErrorCode.LowDifficultyShare], 1);
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
            //console.log(`Adjusting ${this.extraNonceAndSessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            if (!Number.isFinite(targetDiff)) return;
            this.sessionDifficulty = targetDiff;

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
            params: [this.extraNonceAndSessionId, 4]
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
                console.error(`Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`);
                await this.destroy();
                if (!this.socket.destroyed) {
                    this.socket.destroy();
                }
                return false;
            }
        } catch (error) {
            await this.destroy();
            if (!this.socket.writableEnded) {
                this.socket.end();
            } else if (!this.socket.destroyed) {
                this.socket.destroy();
            }
            console.error(`Error occurred while writing to socket: ${this.extraNonceAndSessionId}`, error);
            return false;
        }
    }

}
