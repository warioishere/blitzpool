import { ConfigService } from '@nestjs/config';
import { DIFFICULTY_1 } from '../constants/mining.constants';
import { TimeSlotHelper } from '../utils/time-slot.helper';

const CACHE_SIZE = 30;
const CACHE_WINDOW_SECONDS = 300;
const DEFAULT_MIN_DIFF = 0.00001;

/**
 * Simplified client statistics tracker - PR #109 pattern
 *
 * ONLY handles:
 * 1. Live hashrate calculation
 * 2. Difficulty adjustment
 *
 * Does NOT handle persistence - that's done by ClientStatisticsService
 * Mirrors the PoolShareStatisticsService stateless pattern
 */
export class StratumV1ClientStatistics {

    // Submission cache for difficulty adjustment
    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];

    // Live hashrate calculation (in-memory only)
    public hashRate = 0;
    private currentTimeSlot: number = null;
    private previousTimeSlotTime: Date;
    private currentTimeSlotTime: Date;
    private previousShares: number = 0;
    private shares: number = 0;

    // Configuration
    private targetSharesPerMinute: number;
    private targetSubmissionPerSecond: number;
    /**
     * VarDiff floor. The retarget algorithm will never suggest a value
     * below this. Used on payout-mode ports (PPLNS / group-solo) to
     * keep sub-500 GH/s devices off the pool instead of letting VarDiff
     * drop them into sub-dust-sat territory.
     */
    private readonly minDifficulty: number;

    constructor(targetSharesPerMinute: number, minDifficulty: number = DEFAULT_MIN_DIFF) {
        this.submissionCacheStart = new Date();
        this.targetSharesPerMinute = targetSharesPerMinute > 0 ? targetSharesPerMinute : 6;
        this.targetSubmissionPerSecond = 60 / this.targetSharesPerMinute;
        this.minDifficulty = Number.isFinite(minDifficulty) && minDifficulty > 0
            ? minDifficulty
            : DEFAULT_MIN_DIFF;
    }

    /**
     * Update live hashrate calculation when share is accepted
     * Does NOT persist - caller must use ClientStatisticsService.addAcceptedShare()
     */
    public updateHashRate(targetDifficulty: number) {
        const date = new Date();
        const timeSlot = TimeSlotHelper.getSlotForTime(date.getTime());

        // Update submission cache for difficulty adjustment
        this.updateSubmissionCache(date, targetDifficulty);

        // Update hashrate calculation
        if (this.currentTimeSlot == null) {
            // First share
            this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
        } else if (this.currentTimeSlot != timeSlot) {
            // Transitioning to new time slot
            this.previousShares = this.shares;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
        } else {
            // Same time slot - accumulate for live hashrate
            this.shares += targetDifficulty;
            if (this.shares > 0) {
                const time = date.getTime() - this.previousTimeSlotTime.getTime();
                this.hashRate = ((this.previousShares + this.shares) * DIFFICULTY_1) / (time / 1000);
            }
        }
    }

    /**
     * Maintain sliding window of recent submissions for difficulty adjustment
     */
    private updateSubmissionCache(date: Date, difficulty: number) {
        // Remove submissions older than CACHE_WINDOW_SECONDS
        while (
            this.submissionCache.length &&
            date.getTime() - this.submissionCache[0].time.getTime() > CACHE_WINDOW_SECONDS * 1000
        ) {
            this.submissionCache.shift();
        }

        // Limit cache size
        if (this.submissionCache.length >= CACHE_SIZE) {
            this.submissionCache.shift();
        }

        // Add new submission
        this.submissionCache.push({
            time: date,
            difficulty: difficulty,
        });
    }

    /**
     * Calculate suggested difficulty based on recent submission rate
     * Returns null if no adjustment needed
     */
    public getSuggestedDifficulty(clientDifficulty: number): number | null {

        // miner hasn't submitted enough shares yet
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

    /**
     * Round difficulty to nearest power-of-2 step
     */
    private nearestDifficultyStep(val: number): number | null {
        if (val === 0) {
            return null;
        }
        if (val < this.minDifficulty) {
            return this.minDifficulty;
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
