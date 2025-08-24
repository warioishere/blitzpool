import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ConfigService } from '@nestjs/config';
import { BackgroundQueueService } from '../services/background-queue.service';

const CACHE_SIZE = 30;
const CACHE_WINDOW_SECONDS = 300;
const MIN_DIFF = 0.00001;
export class StratumV1ClientStatistics {

    private shares: number = 0;
    private acceptedCount: number = 0;

    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];

    private currentTimeSlot: number = null;
    private lastSave = 0;
    private currentSlotInserted = false;

    public hashRate = 0;

    private previousTimeSlotTime: Date;
    private currentTimeSlotTime: Date;

    private previousShares: number = 0;
    private targetSharesPerMinute: number;
    private targetSubmissionPerSecond: number;

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly configService: ConfigService,
        private readonly backgroundQueueService: BackgroundQueueService,
    ) {
        this.submissionCacheStart = new Date();
        const tpm = parseFloat(this.configService.get('TARGET_SHARES_PER_MINUTE') ?? '6');
        this.targetSharesPerMinute = isNaN(tpm) ? 6 : tpm;
        this.targetSubmissionPerSecond = 60 / this.targetSharesPerMinute;
    }


    // We don't want to save them here because it can be DB intensive, instead do it every once in
    // awhile with flush()
    public addShares(client: ClientEntity, targetDifficulty: number) {

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

        if (this.currentTimeSlot == null) {
            // First record, start tracking current slot
            this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
            this.acceptedCount = 1;
            this.currentSlotInserted = false;
            this.lastSave = date.getTime();
        } else if (this.currentTimeSlot !== timeSlot) {
            // Transitioning to a new time slot, flush the previous one
            this.flush(client);
            this.previousShares = this.shares;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
            this.acceptedCount = 1;
            this.currentSlotInserted = false;
            this.lastSave = date.getTime();
        } else {
            this.shares += targetDifficulty;
            this.acceptedCount++;
        }

        if (this.shares > 0) {
            const time = new Date().getTime() - this.previousTimeSlotTime.getTime();
            this.hashRate = ((this.previousShares + this.shares) * 4294967296) / (time / 1000);
        }

        // If we haven't saved for a minute, flush current statistics
        if (date.getTime() - this.lastSave > 60 * 1000) {
            this.flush(client);
        }

    }

    public flush(client: ClientEntity) {
        if (this.currentTimeSlot == null) {
            return;
        }

        const data = {
            time: this.currentTimeSlot,
            shares: this.shares,
            acceptedCount: this.acceptedCount,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId,
        };

        if (this.currentSlotInserted) {
            this.backgroundQueueService.enqueue(async () => {
                await this.clientStatisticsService.update(data);
            });
        } else {
            this.backgroundQueueService.enqueue(async () => {
                await this.clientStatisticsService.insert(data);
            });
            this.currentSlotInserted = true;
        }

        this.lastSave = new Date().getTime();
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

        const maxShareDiff = clientDifficulty * 4;
        const sum = this.submissionCache.reduce((pre, cur) => {
            pre += Math.min(cur.difficulty, maxShareDiff);
            return pre;
        }, 0);
        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        if (diffSeconds <= 0) return null;

        const difficultyPerSecond = sum / diffSeconds;
        let targetDifficulty = difficultyPerSecond * this.targetSubmissionPerSecond;
        if (!Number.isFinite(difficultyPerSecond) || !Number.isFinite(targetDifficulty))
            return null;

        const minDifficulty = parseFloat(this.configService.get('MIN_DIFFICULTY')) || MIN_DIFF;
        const maxDifficulty = parseFloat(this.configService.get('MAX_DIFFICULTY')) || Number.MAX_SAFE_INTEGER;

        // allow decrease freely but limit increases to 4x current difficulty
        if (targetDifficulty > clientDifficulty) {
            targetDifficulty = Math.min(targetDifficulty, maxShareDiff);
        }

        targetDifficulty = Math.min(Math.max(targetDifficulty, minDifficulty), maxDifficulty);

        if ((clientDifficulty * 2) < targetDifficulty || (clientDifficulty / 2) > targetDifficulty) {
            targetDifficulty = this.nearestDifficultyStep(targetDifficulty);
            targetDifficulty = Math.min(Math.max(targetDifficulty, minDifficulty), maxDifficulty);
            return targetDifficulty;
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