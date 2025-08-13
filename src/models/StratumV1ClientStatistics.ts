/* eslint-disable prettier/prettier */
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ConfigService } from '@nestjs/config';

const CACHE_SIZE = 30;
const CACHE_WINDOW_SECONDS = 300;
const MIN_DIFF = 0.00001;
export class StratumV1ClientStatistics {

    private _shares = 0;
    private acceptedCount = 0;
    private _savedShares = 0;

    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];

    private _currentTimeSlot: number = null;
    private lastSave: number = null;

        public hashRate = 0;

    private previousTimeSlotTime: Date;
    private currentTimeSlotTime: Date;

    private previousShares = 0;
    private targetSharesPerMinute: number;
    private targetSubmissionPerSecond: number;

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly configService: ConfigService,
    ) {
        this.submissionCacheStart = new Date();
        const tpm = parseFloat(this.configService.get('TARGET_SHARES_PER_MINUTE') ?? '6');
        this.targetSharesPerMinute = isNaN(tpm) ? 6 : tpm;
        this.targetSubmissionPerSecond = 60 / this.targetSharesPerMinute;
    }

    public get shares(): number {
        return this._shares;
    }

    public get savedShares(): number {
        return this._savedShares;
    }

    public get currentTimeSlot(): number {
        return this._currentTimeSlot;
    }


    // We don't want to save them here because it can be DB intensive, instead do it every once in
    // awhile with saveShares()
    public async addShares(client: ClientEntity, targetDifficulty: number) {

        // 10 min
        const coeff = 1000 * 60 * 10;
        const date = new Date();
        const timeSlot = new Date(Math.floor(date.getTime() / coeff) * coeff).getTime();

        while (
            this.submissionCache.length &&
            date.getTime() - this.submissionCache[0].time.getTime() > CACHE_WINDOW_SECONDS * 1000
        ) {
            this.submissionCache.shift();
        }

        if (this.submissionCache.length >= CACHE_SIZE) {
            this.submissionCache.shift();
        }

        this.submissionCache.push({
            time: date,
            difficulty: targetDifficulty,
        });
        this._shares += targetDifficulty;
        this.acceptedCount++;


        if (this._currentTimeSlot == null) {
            // First record, insert it
                        this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this._currentTimeSlot = timeSlot;
            await this.clientStatisticsService.insert({
                time: this._currentTimeSlot,
                shares: this._shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
            this._savedShares = this._shares;
        } else if (this._currentTimeSlot != timeSlot) {
            // Transitioning to a new time slot,
            // First update the old time slot with the latest data
            await this.clientStatisticsService.update({
                time: this._currentTimeSlot,
                shares: this._shares - targetDifficulty,
                acceptedCount: this.acceptedCount - 1,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
                         this.previousShares = this._shares - targetDifficulty;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            // Set the new time slot and add incoming shares then insert it
            this._currentTimeSlot = timeSlot;
            this._shares = targetDifficulty;
            this.acceptedCount = 1
            await this.clientStatisticsService.insert({
                time: this._currentTimeSlot,
                shares: this._shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
            this._savedShares = this._shares;
        } else if ((date.getTime() - 30 * 1000) > this.lastSave) {
            // If we haven't saved for ~30 seconds, update the table
            await this.clientStatisticsService.update({
                time: this._currentTimeSlot,
                shares: this._shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
            this._savedShares = this._shares;
        }

        const elapsed = Date.now() - this.previousTimeSlotTime.getTime();
        if (elapsed > 0) {
            this.hashRate = ((this.previousShares + this._shares) * 4294967296) / (elapsed / 1000);
        }

    }

    public getSuggestedDifficulty(clientDifficulty: number) {

        // miner hasn't submitted shares in one minute
        if (this.submissionCache.length < 5) {
            if ((new Date().getTime() - this.submissionCacheStart.getTime()) / 1000 > 60) {
                return this.nearestDifficultyStep(clientDifficulty / this.targetSharesPerMinute);
            } else {
                return null;
            }
        }

        const sum = this.submissionCache.reduce((pre, cur) => {
            pre += cur.difficulty;
            return pre;
        }, 0);
        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        if (diffSeconds <= 0) return null;

        const difficultyPerSecond = sum / diffSeconds;
        const targetDifficulty = difficultyPerSecond * this.targetSubmissionPerSecond;
        if (!Number.isFinite(difficultyPerSecond) || !Number.isFinite(targetDifficulty))
            return null;

        if ((clientDifficulty * 2) < targetDifficulty || (clientDifficulty / 2) > targetDifficulty) {
            return this.nearestDifficultyStep(targetDifficulty)
        }

        return null;
    }

    private nearestDifficultyStep(val: number): number {
        if (val === 0) {
            return null;
        }
        if (val < MIN_DIFF) {
            return MIN_DIFF;
        }

        const exponent = Math.floor(Math.log2(val));
        const lower = 2 ** exponent;
        const middle = lower + lower / 2;
        const upper = lower * 2;

        const distances = [
            { value: lower, diff: Math.abs(val - lower) },
            { value: middle, diff: Math.abs(val - middle) },
            { value: upper, diff: Math.abs(val - upper) },
        ];

        distances.sort((a, b) => a.diff - b.diff);
        return distances[0].value;
    }

}