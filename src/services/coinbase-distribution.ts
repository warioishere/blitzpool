/**
 * Shared coinbase distribution math for all multi-output payout modes
 * (PPLNS, Group-Solo, and any future PROP/FPPS variants).
 *
 * Given a set of miners who have contributed shares in this distribution
 * round — plus any pending balances carried forward from prior rounds —
 * produce the payout table that goes on-chain as the coinbase outputs.
 *
 * This is a pure function: no Redis, no DB, no side effects beyond a
 * `console.warn` when a weight-budget trim or dust-fee-gate fires. Both
 * `PplnsService` and `GroupSoloService` call this to build their
 * distributions. Fixing a bug here fixes it in every payout mode.
 *
 * ── Invariants the function guarantees ──
 *
 *   1. Sum of `payouts[*].percent` === 100 (up to floating-point rounding).
 *      A sweep step absorbs any rounding remainder into the fee output
 *      (or the last miner if no fee is configured).
 *
 *   2. Converting percent → sats via `floor(percent/100 * blockRewardSats)`
 *      yields totals ≤ `blockRewardSats`. This is the "no bad-cb-amount"
 *      invariant: pending balances are settled OUT OF the miner cut, not
 *      added on top of it, otherwise a coinbase total > blockReward is
 *      rejected by Bitcoin Core with `bad-cb-amount`.
 *
 *   3. Every output is ≥ DUST_LIMIT_SATS. Miners whose share rounds below
 *      dust are dropped from the coinbase and their sats stay in pending
 *      for the next round. The pool-fee output is dust-gated too: at
 *      very low fee percentages the fee output can itself be dust, in
 *      which case it's omitted and miners keep 100 %.
 *
 *   4. The number of outputs fits in `coinbaseWeightBudget`. Smallest
 *      miner outputs are trimmed first; their sats also carry to pending.
 *      Caller is responsible for writing the trimmed-to-pending amounts
 *      back to the balance store.
 *
 *   5. `consideredAddresses` captures every address that was in either
 *      `addressShares` or `pendingBalances` at distribution-build time.
 *      `onBlockFound` paths use it to distinguish sub-dust miners (who
 *      should get their sats credited to pending) from late arrivers —
 *      addresses that submitted shares AFTER the snapshot was built and
 *      must NOT be credited again (the snapshot already paid 100 % of
 *      the miner cut into the coinbase).
 */

export const DUST_LIMIT_SATS = 546;
export const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000;

/**
 * Coinbase structural weight constants, calibrated against the real
 * builder in src/models/MiningJob.ts (createCoinbaseTransaction).
 *
 * BASE    — version + input (coinbase prev-out, script, sequence) +
 *           output-count varint + locktime + witness-reserved-value.
 *           Set to 328 WU = base-fixed (~320) + 8 WU headroom to absorb
 *           the varint-encoding growth of the output-count prefix. A
 *           coinbase with ≤ 252 outputs uses a single-byte varint; at
 *           253 or more outputs the varint expands to 3 bytes (0xfd +
 *           uint16_le), costing 8 WU extra on the wire. A stock
 *           `PPLNS_COINBASE_WEIGHT_BUDGET=50000` already produces 286
 *           miner outputs (+ fee + witness-commitment = 288 total)
 *           which lands inside the wider-varint regime, so the +8 WU
 *           must be paid back here — otherwise the real coinbase
 *           exceeds `blockreservedweight` by 8 WU on a saturated block
 *           and bitcoind rejects it with `bad-blk-weight`. Cheap to
 *           always pay (8 WU ≈ 0.0002 % of a block); no conditional
 *           branching needed.
 *
 * OUTPUT  — P2TR upper bound: 34-byte scriptPubKey → 43 bytes serialized
 *           → 172 WU. Chosen over P2WPKH (124 WU) so a group of all-
 *           Taproot miners can't silently overshoot the budget.
 *
 * WITNESS_COMMITMENT — the segwit-commitment OP_RETURN added by
 *           MiningJob: ~38-byte script → ~47 bytes serialized → ~188 WU.
 *           Earlier code reserved 124 here (treated it as a regular
 *           output) and under-counted by ~64 WU per block.
 */
export const COINBASE_BASE_WEIGHT = 328;
export const COINBASE_OUTPUT_WEIGHT = 172;
export const COINBASE_WITNESS_COMMITMENT_WEIGHT = 188;

export interface CoinbaseDistributionInput {
    /** Share counts (diff1-weighted) by miner address for this round. */
    addressShares: Map<string, number>;
    /**
     * Pending balance (sats) by address carried from prior rounds.
     * Addresses with pending but no current-round shares are still
     * eligible for payout if their pending ≥ dust.
     */
    pendingBalances: Map<string, number>;
    /** Full block reward in sats (subsidy + mempool fees). */
    blockRewardSats: number;
    /** Pool fee percent, e.g. 2 for 2 %. */
    feePercent: number;
    /** Pool fee payout address. Empty string → no fee output emitted. */
    feeAddress: string;
    /**
     * Max weight units for coinbase outputs. Typically mirrors
     * bitcoin.conf's `blockreservedweight`. Defaults to 50 000 WU if
     * the caller passes 0 or negative.
     */
    coinbaseWeightBudget: number;
    /**
     * Optional logging prefix for the `console.warn` emitted by the
     * weight-trim and fee-dust gates. Pass e.g. '[PPLNS]' or
     * '[GroupSolo grp-1]' so operators can trace which engine fired.
     */
    logLabel?: string;
}

export interface CoinbaseDistributionEntry {
    address: string;
    percent: number;
}

export interface CoinbaseDistributionResult {
    /**
     * Array of `{ address, percent }` ready to be converted to coinbase
     * outputs. Percents sum to 100 (up to rounding). When the pool
     * has no miners and no fee configured, this is an empty array.
     */
    payouts: CoinbaseDistributionEntry[];
    /**
     * Every address that was in `addressShares` or `pendingBalances`
     * when the distribution was built. `onBlockFound` uses this to
     * distinguish sub-dust / trimmed miners (credit to pending) from
     * late arrivers that appear in Redis after the snapshot was built
     * (audit only, no credit — would double-count).
     */
    consideredAddresses: Set<string>;
    /**
     * Total pending sats that were absorbed into this distribution.
     * Callers should clear exactly this amount across the participating
     * miners' pending rows after the block is on-chain, keeping
     * bookkeeping consistent with what went into the coinbase.
     */
    totalPendingSettled: number;
}

/**
 * Pure coinbase-distribution builder. See top-of-file docblock for the
 * invariants it maintains. Returns fallback (100 % to fee, or empty
 * array if no fee address) when there are no shares.
 */
export function buildCoinbaseDistribution(
    input: CoinbaseDistributionInput,
): CoinbaseDistributionResult {
    const {
        addressShares,
        pendingBalances,
        blockRewardSats,
        feePercent,
        feeAddress,
        coinbaseWeightBudget,
        logLabel,
    } = input;

    const label = logLabel ?? '[CoinbaseDist]';
    const budget = coinbaseWeightBudget > 0 ? coinbaseWeightBudget : DEFAULT_COINBASE_WEIGHT_BUDGET;

    // ── Early exit: no work done this round ─────────────────────
    let totalDiff = 0;
    for (const d of addressShares.values()) totalDiff += d;

    const consideredAddresses = new Set<string>(addressShares.keys());
    for (const addr of pendingBalances.keys()) consideredAddresses.add(addr);

    if (addressShares.size === 0 || totalDiff <= 0) {
        return {
            payouts: feeAddress ? [{ address: feeAddress, percent: 100 }] : [],
            consideredAddresses,
            totalPendingSettled: 0,
        };
    }

    // ── Core math: settle pending out of the miner cut ──────────
    const rewardForMiners = Math.floor(((100 - feePercent) / 100) * blockRewardSats);
    const totalPending = Array.from(pendingBalances.values()).reduce((s, v) => s + v, 0);

    // Pathological-case guard: if accumulated pending exceeds what this
    // block's miner cut can cover, we cannot emit a valid coinbase — the
    // per-miner totalSats would sum to > rewardForMiners, and combined
    // with the fee output the coinbase total would exceed blockReward,
    // causing Core to reject with `bad-cb-amount`. Pre-fix the code silently
    // produced that invalid distribution because the remainder-sweep only
    // handles the under-100% case.
    //
    // Safe fallback: emit a fee-100% payout (or empty array when no fee
    // address is configured). The block still lands, the pool operator
    // takes the fee for this block only, and all miners' pending is
    // preserved for future blocks where the ratio recovers. A loud
    // console.error is intentional — this must never happen silently.
    if (totalPending > rewardForMiners) {
        console.error(
            `${label} CRITICAL: totalPending ${totalPending} > rewardForMiners ${rewardForMiners} `
            + `(blockReward ${blockRewardSats}, fee ${feePercent}%). Emitting fee-100% fallback; `
            + `miner pending preserved for future blocks. Investigate pending accumulation.`,
        );
        return {
            payouts: feeAddress ? [{ address: feeAddress, percent: 100 }] : [],
            consideredAddresses,
            totalPendingSettled: 0,
        };
    }

    const effectiveMinerReward = Math.max(0, rewardForMiners - totalPending);

    const minerShares: { address: string; sats: number; percent: number }[] = [];
    for (const [addr, diff] of addressShares) {
        const ratio = diff / totalDiff;
        const baseSats = Math.floor(ratio * effectiveMinerReward);
        const pending = pendingBalances.get(addr) ?? 0;
        const totalSats = baseSats + pending;
        minerShares.push({
            address: addr,
            sats: totalSats,
            percent: (totalSats / blockRewardSats) * 100,
        });
    }

    // Pending-only: miners with accumulated sats but no shares this round.
    // They only show up in the coinbase when their pending ≥ dust on its own.
    for (const [addr, pending] of pendingBalances) {
        if (!addressShares.has(addr) && pending >= DUST_LIMIT_SATS) {
            minerShares.push({
                address: addr,
                sats: pending,
                percent: (pending / blockRewardSats) * 100,
            });
        }
    }

    // ── Dust filter + weight-budget trim ────────────────────────
    const eligible = minerShares
        .filter(m => m.sats >= DUST_LIMIT_SATS)
        .sort((a, b) => b.sats - a.sats);

    const feeOutputCount = feeAddress ? 1 : 0;
    const maxMinerOutputs = Math.floor(
        (budget
            - COINBASE_BASE_WEIGHT
            - COINBASE_WITNESS_COMMITMENT_WEIGHT
            - feeOutputCount * COINBASE_OUTPUT_WEIGHT)
        / COINBASE_OUTPUT_WEIGHT,
    );

    const trimmed = eligible.length > maxMinerOutputs && maxMinerOutputs > 0
        ? eligible.slice(0, maxMinerOutputs)
        : eligible;

    if (trimmed.length < eligible.length) {
        console.warn(`${label} trimmed ${eligible.length - trimmed.length} smallest outputs to pending (${eligible.length} → ${trimmed.length}, budget ${budget} WU)`);
    }

    const payouts: CoinbaseDistributionEntry[] = trimmed.map(m => ({
        address: m.address,
        percent: m.percent,
    }));
    let totalAssigned = trimmed.reduce((s, m) => s + m.percent, 0);

    // ── Fee output, dust-gated ─────────────────────────────────
    let feeEmitted = false;
    if (feeAddress) {
        const feeSats = Math.floor((feePercent / 100) * blockRewardSats);
        if (feeSats >= DUST_LIMIT_SATS) {
            payouts.unshift({ address: feeAddress, percent: feePercent });
            totalAssigned += feePercent;
            feeEmitted = true;
        } else {
            console.warn(`${label} fee output ${feeSats} sats < dust (${DUST_LIMIT_SATS}) — omitting fee, miners keep 100 %`);
        }
    }

    // ── Sweep rounding remainder ───────────────────────────────
    // Sub-dust miners and integer-division rounding leave a small gap
    // under 100 %. Push it into the fee output if we emitted one,
    // otherwise into the largest miner so nothing vanishes.
    if (payouts.length > 0 && totalAssigned < 100) {
        const remainder = 100 - totalAssigned;
        if (feeEmitted) {
            payouts[0].percent += remainder;
        } else {
            payouts[payouts.length - 1].percent += remainder;
        }
    }

    return {
        payouts: payouts.length > 0
            ? payouts
            : (feeAddress ? [{ address: feeAddress, percent: 100 }] : []),
        consideredAddresses,
        totalPendingSettled: totalPending,
    };
}
