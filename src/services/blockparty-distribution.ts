// Copyright (c) 2025-2026 warioishere (blitzpool). Licensed under GPL-3.0-or-later.

import { CoinbaseDistributionEntry, DUST_LIMIT_SATS } from './coinbase-distribution';

export interface BlockpartyMemberInput {
    address: string;
    /** Basis points: 100 = 1%, 10000 = 100%. */
    percentBp: number;
}

export interface BlockpartyDistributionInput {
    members: BlockpartyMemberInput[];
    blockRewardSats: number;
    poolFeeAddress: string;
    /** Decimal percent (e.g. 2 for 2%). */
    poolFeePercent: number;
    /** Sub-threshold per-member outputs roll into the pool-fee output. */
    minPayoutSats: number;
}

export interface BlockpartyDistributionSplit {
    address: string;
    percentBp: number;
    sats: number;
    /**
     * True when this member's nominal share fell below `minPayoutSats`
     * and was rolled into the pool-fee output instead. `sats` is then 0.
     */
    trimmed: boolean;
}

export interface BlockpartyDistributionResult {
    /** Per-member breakdown — one entry per input member, same order. */
    splits: BlockpartyDistributionSplit[];
    /** Final pool-fee output sats (base fee + rounding remainder + trimmed amounts). */
    poolFeeSats: number;
    /** Ready for coinbase output construction — pool fee first, then members. */
    payouts: CoinbaseDistributionEntry[];
}

/**
 * Pure-function payout split for Blockparty groups.
 *
 * Construction (no shares, no balance ledger):
 *   1. basePoolFee  = floor(reward * poolFeePercent / 100)
 *   2. minerCut     = reward - basePoolFee
 *   3. per member   = floor(minerCut * percentBp / 10000)
 *   4. sub-threshold members (memberSats < minPayoutSats) → 0 sats, trimmed flag,
 *      their nominal sats roll into the pool-fee output (project decision: no
 *      carry-forward, no dust pending — sub-dust enriches the pool address).
 *   5. rounding leftover (reward − sum of paid outputs) → also folded into
 *      the pool-fee output so total outputs == reward exactly.
 *
 * Inputs are trusted: percentBp sum is enforced at the service layer
 * (must equal 10000 = 100% of miner cut). This function tolerates a
 * mis-summed input by under/overpaying — the service must validate
 * before calling.
 */
export function buildBlockpartyDistribution(input: BlockpartyDistributionInput): BlockpartyDistributionResult {
    const { members, blockRewardSats, poolFeeAddress, poolFeePercent, minPayoutSats } = input;

    if (blockRewardSats <= 0) {
        return { splits: [], poolFeeSats: 0, payouts: [] };
    }
    if (members.length === 0) {
        const poolFee = blockRewardSats;
        return {
            splits: [],
            poolFeeSats: poolFee,
            payouts: poolFeeAddress
                ? [{ address: poolFeeAddress, percent: 100, sats: poolFee }]
                : [],
        };
    }

    const dustThreshold = Math.max(minPayoutSats, DUST_LIMIT_SATS);
    const basePoolFeeSats = Math.floor((blockRewardSats * poolFeePercent) / 100);
    const minerCutSats = blockRewardSats - basePoolFeeSats;

    const splits: BlockpartyDistributionSplit[] = members.map(m => {
        const nominal = Math.floor((minerCutSats * m.percentBp) / 10000);
        if (nominal < dustThreshold) {
            return { address: m.address, percentBp: m.percentBp, sats: 0, trimmed: true };
        }
        return { address: m.address, percentBp: m.percentBp, sats: nominal, trimmed: false };
    });

    const paidToMembers = splits.reduce((acc, s) => acc + s.sats, 0);
    const poolFeeSats = blockRewardSats - paidToMembers;

    const payouts: CoinbaseDistributionEntry[] = [];
    if (poolFeeAddress && poolFeeSats > 0) {
        payouts.push({
            address: poolFeeAddress,
            percent: (poolFeeSats / blockRewardSats) * 100,
            sats: poolFeeSats,
        });
    }
    for (const s of splits) {
        if (s.sats > 0) {
            payouts.push({
                address: s.address,
                percent: (s.sats / blockRewardSats) * 100,
                sats: s.sats,
            });
        }
    }

    return { splits, poolFeeSats, payouts };
}
