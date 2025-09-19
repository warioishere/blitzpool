import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ConfigService } from '@nestjs/config';

const CACHE_SIZE = 30;
const CACHE_WINDOW_SECONDS = 300;
const MIN_DIFF = 0.00001;
export class StratumV1ClientStatistics {

    private shares: number = 0;
    private acceptedCount: number = 0;
    private rejectedCount: number = 0;

    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];

    private currentTimeSlot: number = null;
    private lastSave: number = null;
	
	public hashRate = 0;

    private previousTimeSlotTime: Date;
    private currentTimeSlotTime: Date;

    private previousShares: number = 0;
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


    // We don't want to save them here because it can be DB intensive, instead do it every once in
    // awhile with saveShares()
    public async addShares(client: ClientEntity, targetDifficulty: number) {

        // 10 min
        var coeff = 1000 * 60 * 10;
        var date = new Date();
        var timeSlot = new Date(Math.floor(date.getTime() / coeff) * coeff).getTime();

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


        if (this.currentTimeSlot == null) {
            // First record, insert it
			this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares += targetDifficulty;
            this.acceptedCount++;
            this.rejectedCount = 0;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
        } else if (this.currentTimeSlot != timeSlot) {
            // Transitioning to a new time slot,
            // First update the old time slot with the latest data
            await this.clientStatisticsService.update({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
			 this.previousShares = this.shares;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            // Set the new time slot and add incoming shares then insert it
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
            this.acceptedCount = 1;
            this.rejectedCount = 0;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
        } else if ((date.getTime() - 60 * 1000) > this.lastSave) {
            // If we haven't saved for a minute, update the table
            this.shares += targetDifficulty;
            this.acceptedCount++;
            await this.clientStatisticsService.update({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = new Date().getTime();
        } else {
            // Accept the shares if none of the prior conditions are met,
            // saving to memory for storing later
            this.shares += targetDifficulty;
            this.acceptedCount++;
			if(this.shares > 0) {
            const time = new Date().getTime() - this.previousTimeSlotTime.getTime();
            this.hashRate = ((this.previousShares + this.shares) * 4294967296) / (time / 1000);
        }
        }

    }

    public async addRejectedShare(client: ClientEntity) {

        var coeff = 1000 * 60 * 10;
        var date = new Date();
        var timeSlot = new Date(Math.floor(date.getTime() / coeff) * coeff).getTime();

        if (this.currentTimeSlot == null) {
            this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = this.shares ?? 0;
            this.acceptedCount = this.acceptedCount ?? 0;
            this.rejectedCount = 1;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = null;
            return;
        }

        if (this.currentTimeSlot != timeSlot) {
            await this.clientStatisticsService.update({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.previousShares = this.shares;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = 0;
            this.acceptedCount = 0;
            this.rejectedCount = 1;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.lastSave = null;
            return;
        }

        this.rejectedCount++;
        await this.clientStatisticsService.update({
            time: this.currentTimeSlot,
            shares: this.shares,
            acceptedCount: this.acceptedCount,
            rejectedCount: this.rejectedCount,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId
        });
        this.lastSave = null;
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
