/**
 * Shared coinbase distribution math for PPLNS (and any future
 * proportional-coinbase payout mode). Group-Solo stays on its simpler
 * fallback path — its round resets per block, never accumulates
 * sub-dust / trim tails, and the operator's constraint is "groups
 * never get large enough to trim".
 *
 * ── The credit/debit ledger model ───────────────────────────────
 *
 * Every PPLNS miner has a signed `balance` stored in pplns_balance:
 *
 *     balance > 0  →  pool owes miner that many sats (pending credit)
 *     balance < 0  →  miner owes pool that many sats (pending debit)
 *     balance = 0  →  no open claim
 *
 * The sum of all miners' balances is designed to stay at 0 in a
 * steady-state pool. Every credit granted to one miner is offset by
 * a matching debit on one or more other miners, both booked in the
 * same block-found transaction.
 *
 * ── Per-block algorithm ─────────────────────────────────────────
 *
 *   Phase 1: raw_fair(m) = floor(shares(m) / totalShares × rewardForMiners)
 *             for every miner active in this block's window.
 *
 *   Phase 2: target(m) = raw_fair(m) + balance_old(m)
 *             (`balance_old` is 0 for miners who weren't in the ledger
 *              at block-build time, a signed sats value otherwise.)
 *
 *   Phase 3: Eligibility — a miner's on-chain output is at least dust
 *             iff target(m) ≥ DUST_LIMIT_SATS. Otherwise the miner
 *             stays off-chain; their target becomes the new balance
 *             (which can be positive or negative).
 *
 *   Phase 4: Weight-budget trim — if the eligible count exceeds the
 *             coinbase weight budget's capacity, drop the lowest-target
 *             miners. Their target values become their new balance.
 *             The summed target of the trimmed miners is redistributed
 *             to the kept active miners weighted by their share ratios;
 *             those bonus recipients get an on-chain top-up AND a
 *             matching debit on their new balance. Their fair-share
 *             claim on this block is thus over-satisfied by the trim
 *             bonus, which will be settled out of their own fair share
 *             in a future block.
 *
 *   Phase 5a.5: Solvency cap — if sum(kept.onChain) > rewardForMiners
 *             after Phase 5a, an abandoned debtor has left a positive
 *             credit in the kept set without a matching backing debit
 *             in this block. We cannot emit more coinbase than the
 *             reward allows, so we reduce the credit-claimers'
 *             on-chain amounts proportionally to their balance_old
 *             and carry the uncovered portion forward. Active
 *             miners' rawFair is untouched. Falls back to fee-100 %
 *             only in the mathematically-impossible case of overshoot
 *             without a credit-claimer.
 *
 *   Phase 5b: Residuum distribution — any positive residuum (from
 *             Phase 1 floor-rounding, or from sub-dust miners whose
 *             rawFair stayed in their own ledger balance) is
 *             distributed to kept active miners proportionally to
 *             their shares, with matching per-miner debits so the
 *             ledger stays pool-neutral. Proportional (rather than
 *             all-to-largest) keeps per-miner debits small and
 *             easier to pair-neutralise during future sweep runs.
 *
 * ── Non-custodial guarantees ────────────────────────────────────
 *
 *   - Fee receives exactly `feePercent` of the block reward. Never
 *     more. No sub-dust sweep, no trim sweep, nothing silently
 *     inflates the operator's cut.
 *
 *   - Every coinbase output goes to either a miner address or the
 *     fee address. The pool operator holds no funds between blocks.
 *     Sats that can't be placed on-chain in this block (because the
 *     miner's target < dust, or they were trimmed) stay as a pending
 *     credit/debit in the ledger, not on a pool wallet.
 *
 *   - Block B miners do NOT pay for Block A's trimmed miners. The
 *     miners who got the on-chain bonus in Block A are the ones whose
 *     fair-share shrinks when they return in subsequent blocks. Their
 *     debit is repaid from their OWN work, not from unrelated miners.
 *
 * ── Abandonment edge-case ───────────────────────────────────────
 *
 *   When a miner goes inactive for ABANDONED_BALANCE_DAYS (3 months)
 *   with a non-zero balance, DustSweepService considers their row for
 *   pair-cancellation. The sweep treats abandoned positives (credits)
 *   and abandoned negatives (debits) as counterparty pools:
 *
 *     - Pair-match: largest abandoned credit against largest
 *       abandoned debit, cancel matching amounts on both sides.
 *       Repeat until one side is exhausted.
 *
 *     - Unpaired remainder: rows stay in the ledger. Nothing is
 *       silently zeroed while an active counterparty still exists,
 *       so sum(balances) = 0 is strictly preserved even across
 *       sweeps. Unpaired credits wait for their debtor to either
 *       return (offsets via reduced rawFair) or become dormant
 *       themselves (triggers pair-sweep). Symmetrically for debits.
 *
 *   Why pair-sweeping rather than redistributing abandoned credits
 *   to active miners: the physical sats that would back such
 *   redistribution are already on-chain in a prior block's coinbase,
 *   sitting in the abandoned debtor's wallet. The pool is non-
 *   custodial and cannot recover them, so any redistribution would
 *   have to come out of active miners' own fair-share budget —
 *   which violates the "active miners never pay for abandoners"
 *   guarantee. Pair-cancellation is the one rebalance that is
 *   materially neutral for everyone else.
 *
 *   In the asymmetric window (credit abandoned, debitor still
 *   active or vice versa), the Phase 5a.5 solvency cap delays the
 *   credit claim block-by-block but never denies it; and vice
 *   versa, the active debtor's future blocks slowly offset their
 *   debit via reduced rawFair. The ledger never drifts away from
 *   sum = 0.
 */

/**
 * Bitcoin Core's default dust policy value for P2PKH at
 * `dustRelayFee = 3000 sat/kvB`. Outputs below this amount can't be
 * relayed as standard transactions, so it's the absolute lower bound
 * for any on-chain coinbase output we emit. Operationally the pool
 * uses a higher "minimum payout" value (see `DEFAULT_MIN_PAYOUT_SATS`
 * and the `minPayoutSats` parameter) because 546-sat outputs are
 * economically unspendable at realistic network fee rates (~8 sat/vB
 * break-even for P2WPKH).
 */
export const DUST_LIMIT_SATS = 546;

/**
 * Pool's default minimum on-chain payout. Outputs below this amount
 * stay as pending credit in the signed ledger until they accumulate
 * past the threshold. Overridable per deployment via
 * `PPLNS_MIN_PAYOUT_SATS` (clamped to ≥ DUST_LIMIT_SATS in service).
 * Chosen so outputs remain spendable at fee rates up to ~73 sat/vB
 * for P2WPKH inputs.
 */
export const DEFAULT_MIN_PAYOUT_SATS = 5_000;

export const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000;

/**
 * Coinbase structural weight constants, calibrated against the real
 * builder in src/models/MiningJob.ts (createCoinbaseTransaction).
 *
 * BASE    — version + input (coinbase prev-out, script, sequence) +
 *           output-count varint + locktime + witness-reserved-value.
 *           Set to 328 WU = base-fixed (~320) + 8 WU headroom to
 *           absorb the varint-encoding growth of the output-count
 *           prefix once total outputs exceed 252. See the commit
 *           that introduced 328 for the full math.
 *
 * OUTPUT  — P2TR upper bound: 34-byte scriptPubKey → 43 bytes
 *           serialized → 172 WU. Conservative choice over P2WPKH (124
 *           WU) so a group of all-Taproot miners can't silently
 *           overshoot the budget.
 *
 * WITNESS_COMMITMENT — segwit-commitment OP_RETURN: ~38-byte script
 *           → ~47 bytes serialized → ~188 WU.
 */
export const COINBASE_BASE_WEIGHT = 328;
export const COINBASE_OUTPUT_WEIGHT = 172;
export const COINBASE_WITNESS_COMMITMENT_WEIGHT = 188;

export interface CoinbaseDistributionInput {
    /** Share counts (diff1-weighted) by miner address for this round. */
    addressShares: Map<string, number>;
    /**
     * Signed ledger balances by address at distribution-build time.
     *   positive → pool owes miner that many sats
     *   negative → miner owes pool that many sats
     * Addresses with a 0 balance can be omitted; addresses with
     * non-zero balance but no current shares are pending-only miners
     * who may still get an output this block if their credit ≥ dust.
     */
    balances: Map<string, number>;
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
     * Optional logging prefix for the `console.warn` / `console.error`
     * lines emitted by edge-case paths. Pass e.g. '[PPLNS]' so
     * operators can trace which engine fired.
     */
    logLabel?: string;
    /**
     * When true, Phase 5a (trim redistribution) and Phase 5b (floor-
     * rounding residuum) do NOT create matching debits on kept active
     * miners. Instead, any unassigned sats go to the fee output. If no
     * fee address is configured, they remain unemitted (block coinbase
     * undershoots by that amount — at most a few sats per block).
     *
     * Used by Group-Solo so member balances stay on the simpler
     * unsigned-pending model: `pplns_group_balance.pendingSats` is
     * always ≥ 0, the legacy single-sided dust sweep works as
     * designed, and member-kick redistribution semantics stay intact.
     *
     * The cost is that floor-rounding residuum (~1–10 sats/block for
     * a 10-member group) is donated to the fee rather than absorbed
     * by a miner. For PPLNS this tradeoff is undesirable (miners
     * should keep every sat they earn, even if it means carrying a
     * tiny debit); for Group-Solo the simpler model outweighs the
     * cost of a few hundred thousand sats/year per active group.
     */
    suppressMatchingDebits?: boolean;
    /**
     * Pool's chosen minimum on-chain output. Outputs whose target
     * (rawFair + balanceOld) falls below this amount stay as pending
     * credit instead of becoming a coinbase output. Defaults to
     * `DUST_LIMIT_SATS` (546) — the Bitcoin Core policy floor — so
     * existing tests keep their meaning. Production services pass a
     * higher value (default 5 000) to avoid emitting outputs that
     * are economically unspendable at realistic network fee rates.
     */
    minPayoutSats?: number;
    /**
     * Group-Solo finder-bonus: absolute sats paid to the block-finder
     * as a separate coinbase output, on top of their normal proportional
     * share. The remaining miner-cut (after fee + bonus) is split
     * proportionally as usual, so the finder gets bonus + their share.
     *
     * Capped at 95 % of the miner-cut at runtime — protects the rest
     * of the group from being starved if the configured bonus is too
     * large for the post-halving block subsidy. If the resulting
     * bonus is below `minPayoutSats` it is suppressed entirely and
     * the original miner-cut is restored (caller should validate at
     * configure-time, this is defensive).
     *
     * Both `finderBonusSats` and `finderAddress` must be set together;
     * either being unset/0 disables the feature.
     */
    finderBonusSats?: number;
    finderAddress?: string;
}

export interface CoinbaseDistributionEntry {
    address: string;
    /** Share of the block reward as a percent (0-100). */
    percent: number;
    /** On-chain sats this output carries (authoritative; percent is derived). */
    sats: number;
}

export interface CoinbaseDistributionResult {
    /**
     * Array of `{ address, percent, sats }` ready to be converted
     * into coinbase outputs. Total sats ≤ blockRewardSats by
     * construction. When the pool has no miners and no fee
     * configured, this is an empty array.
     */
    payouts: CoinbaseDistributionEntry[];
    /**
     * Every address that was in `addressShares` or `balances` when
     * the distribution was built. `onBlockFound` paths use this to
     * distinguish miners who were considered at snapshot time from
     * late arrivers whose shares landed after the snapshot was
     * persisted.
     */
    consideredAddresses: Set<string>;
    /**
     * New absolute balance for each miner whose ledger state changed
     * as a result of this distribution. Keys cover:
     *
     *   - every miner who had a non-zero `balances` entry on input
     *     (their balance may now be 0, unchanged, or still non-zero
     *     depending on whether their target cleared dust)
     *   - every active miner in `addressShares` whose resulting
     *     balance is non-zero (sub-dust / trimmed miners who gained
     *     pending credit, or bonus recipients who picked up a new
     *     debit from the trim redistribution)
     *
     * Miners with a resulting balance of 0 who had a 0 balance on
     * input are NOT included — no ledger change to persist.
     *
     * Callers apply these as absolute `balanceSats = balanceAfter.get(addr)`
     * writes inside the block-found transaction.
     */
    balanceAfter: Map<string, number>;
}

interface MinerComputation {
    address: string;
    shares: number;         // 0 for pending-only miners
    rawFair: number;         // floor(ratio × rewardForMiners), 0 if not active
    balanceOld: number;      // signed input balance
    target: number;          // rawFair + balanceOld
    eligible: boolean;       // target ≥ dust
    // Set in phases 4-5:
    onChain: number;         // final sats in this block's coinbase for this miner
    balanceNew: number;      // resulting ledger balance after this block
}

export function buildCoinbaseDistribution(
    input: CoinbaseDistributionInput,
): CoinbaseDistributionResult {
    const {
        addressShares,
        balances,
        blockRewardSats,
        feePercent,
        feeAddress,
        coinbaseWeightBudget,
        logLabel,
        suppressMatchingDebits,
        minPayoutSats,
        finderBonusSats: configuredBonusSats,
        finderAddress,
    } = input;

    const label = logLabel ?? '[CoinbaseDist]';
    const budget = coinbaseWeightBudget > 0 ? coinbaseWeightBudget : DEFAULT_COINBASE_WEIGHT_BUDGET;
    // Effective minimum-payout floor. Defaults to DUST_LIMIT_SATS so
    // unit tests that don't pass the param keep their old behavior.
    // Always enforce a hard lower bound at DUST_LIMIT_SATS — emitting
    // outputs below that violates Bitcoin Core relay policy.
    const minPayout = Math.max(
        DUST_LIMIT_SATS,
        (minPayoutSats !== undefined && minPayoutSats > 0) ? minPayoutSats : DUST_LIMIT_SATS,
    );

    const consideredAddresses = new Set<string>(addressShares.keys());
    for (const addr of balances.keys()) consideredAddresses.add(addr);

    // ── Early exit: no shares this block ──────────────────────────
    // We keep balances exactly as-is — no work was done, no ledger
    // mutation is justified. Coinbase goes 100 % to fee (or empty).
    let totalShares = 0;
    for (const d of addressShares.values()) totalShares += d;

    if (addressShares.size === 0 || totalShares <= 0) {
        return {
            payouts: feeAddress
                ? [{ address: feeAddress, percent: 100, sats: blockRewardSats }]
                : [],
            consideredAddresses,
            balanceAfter: new Map(),
        };
    }

    // Fee is only deducted from miner reward when it will actually be
    // emitted as a coinbase output. Two cases skip it: feeAddress is
    // unset (no recipient configured), or the would-be fee is below
    // minPayout (Bitcoin Core relay policy rejects sub-dust outputs).
    // Without this guard the coinbase under-claims by feeSats and those
    // sats are forfeited — no one is paid, and miners are short-changed.
    const wantFeeSats = Math.floor((feePercent / 100) * blockRewardSats);
    const feeEmitted = !!feeAddress && wantFeeSats >= minPayout;
    const feeSats = feeEmitted ? wantFeeSats : 0;
    let rewardForMiners = blockRewardSats - feeSats;

    // Group-Solo finder bonus: subtracted from rewardForMiners BEFORE
    // the proportional split, emitted as its own coinbase output. Cap
    // at 95 % of rewardForMiners so the rest of the group can't be
    // starved on small post-halving rewards. Only emit if the resulting
    // amount clears minPayout — otherwise restore rewardForMiners and
    // skip the bonus output entirely.
    const wantBonusSats = (configuredBonusSats && finderAddress) ? configuredBonusSats : 0;
    const bonusCapSats = Math.floor(rewardForMiners * 0.95);
    const cappedBonusSats = Math.min(wantBonusSats, bonusCapSats);
    const bonusEmitted = cappedBonusSats >= minPayout;
    const bonusSats = bonusEmitted ? cappedBonusSats : 0;
    rewardForMiners -= bonusSats;

    // ── Phase 1 + 2: compute rawFair + target per miner ────────────
    const computations = new Map<string, MinerComputation>();

    for (const [addr, shares] of addressShares) {
        const ratio = shares / totalShares;
        const rawFair = Math.floor(ratio * rewardForMiners);
        const balanceOld = balances.get(addr) ?? 0;
        const target = rawFair + balanceOld;
        computations.set(addr, {
            address: addr,
            shares,
            rawFair,
            balanceOld,
            target,
            eligible: target >= minPayout,
            onChain: 0,
            balanceNew: target,       // default if not picked up in a block
        });
    }

    // Pending-only miners (non-zero balance, no shares this block)
    for (const [addr, balanceOld] of balances) {
        if (addressShares.has(addr)) continue;
        if (balanceOld === 0) continue;
        const target = balanceOld;
        computations.set(addr, {
            address: addr,
            shares: 0,
            rawFair: 0,
            balanceOld,
            target,
            eligible: target >= minPayout,
            onChain: 0,
            balanceNew: target,
        });
    }

    // ── Phase 3+4: eligibility + weight-budget trim ────────────────
    // feeEmitted was decided above (alongside feeSats / rewardForMiners)
    // so that miner reward and the fee-output gate stay consistent —
    // i.e. the fee is either subtracted AND emitted, or neither.
    const feeOutputCount = feeEmitted ? 1 : 0;
    const bonusOutputCount = bonusEmitted ? 1 : 0;
    const maxMinerOutputs = Math.floor(
        (budget
            - COINBASE_BASE_WEIGHT
            - COINBASE_WITNESS_COMMITMENT_WEIGHT
            - feeOutputCount * COINBASE_OUTPUT_WEIGHT
            - bonusOutputCount * COINBASE_OUTPUT_WEIGHT)
        / COINBASE_OUTPUT_WEIGHT,
    );

    const eligibleList = Array.from(computations.values())
        .filter(c => c.eligible)
        .sort((a, b) => b.target - a.target);

    const keptCount = eligibleList.length > maxMinerOutputs && maxMinerOutputs > 0
        ? maxMinerOutputs
        : eligibleList.length;
    const kept = eligibleList.slice(0, keptCount);
    const trimmed = eligibleList.slice(keptCount);

    if (trimmed.length > 0) {
        console.warn(
            `${label} trimmed ${trimmed.length} smallest outputs to balance `
            + `(${eligibleList.length} → ${kept.length}, budget ${budget} WU)`,
        );
    }

    // Kept miners: they get their target on-chain, balance clears to 0.
    for (const c of kept) {
        c.onChain = c.target;
        c.balanceNew = 0;
    }
    // Trimmed miners: no on-chain this block, their target stays as balance.
    // (The target already equals rawFair + balanceOld, which is the "full
    // amount owed" — so leaving balanceNew = target correctly carries
    // their claim forward.)

    // Sub-dust / negative-target miners: same — no on-chain, balance = target.

    // ── Phase 5a: redistribute trimmed amount to kept active miners ─
    // Bonus is proportional to the bonus-recipient's share in the current
    // window (not their fair_share, not their target — shares are the
    // pure "work this block" signal). Only active miners get bonus;
    // pending-only miners don't receive redistribution (they weren't
    // doing work this round).
    //
    // Only redistribute the portion of each trimmed miner's target that
    // represents sats earned THIS BLOCK (rawFair + current balanceOld of
    // active miners). Pending-only trimmed miners (shares=0, target=
    // balanceOld) have a claim on past-block sats; those cannot be
    // physically redistributed this block without creating phantom sats
    // that the Phase 5a.5 solvency cap cannot absorb. Their balanceNew
    // stays as target (credit carries forward unchanged).
    let trimmedTotal = 0;
    for (const c of trimmed) trimmedTotal += c.shares > 0 ? c.target : 0;

    // Fee-bonus accumulator for suppressMatchingDebits mode: trim
    // redistribution + Phase 5b residuum get added to the fee output
    // instead of creating matching debits on active miners.
    let feeBonusSats = 0;

    if (trimmedTotal > 0) {
        if (suppressMatchingDebits) {
            // Group-Solo path: donate trim leftovers to fee. No matching
            // debits means no negative balances on members' pending rows.
            // In practice this branch is unreachable for groups
            // (member count << maxMinerOutputs), but handled for
            // completeness so the invariant holds everywhere.
            feeBonusSats += trimmedTotal;
        } else {
            const keptActive = kept.filter(c => c.shares > 0);
            let keptActiveShares = 0;
            for (const c of keptActive) keptActiveShares += c.shares;

            if (keptActiveShares > 0) {
                let bonusAssigned = 0;
                // Floor per-miner, then rounding residuum goes to the single
                // largest bonus recipient so the sum stays ≤ trimmedTotal.
                for (const c of keptActive) {
                    const bonus = Math.floor(trimmedTotal * c.shares / keptActiveShares);
                    c.onChain += bonus;
                    c.balanceNew -= bonus;   // recipient now owes the pool this bonus
                    bonusAssigned += bonus;
                }
                const bonusResiduum = trimmedTotal - bonusAssigned;
                if (bonusResiduum > 0 && keptActive.length > 0) {
                    // Push the residuum to the largest bonus recipient.
                    const sortedByShares = [...keptActive].sort((a, b) => b.shares - a.shares);
                    const biggest = sortedByShares[0];
                    biggest.onChain += bonusResiduum;
                    biggest.balanceNew -= bonusResiduum;
                }
            } else {
                // Edge: trimmed miners exist but no kept active miners got
                // the bonus (e.g. kept set is all pending-only). The trimmed
                // sats would be unclaimed. Log loud; the trimmed miners'
                // balanceNew = target still records their claim, and the
                // block coinbase will undershoot rewardForMiners slightly.
                console.warn(
                    `${label} trimmed ${trimmedTotal} sats but no active kept miners `
                    + `to receive redistribution — block coinbase will undershoot`,
                );
            }
        }
    }

    // ── Phase 5a.5: Solvency cap — abandoned-debtor overshoot guard ─
    // Compute preliminary on-chain total. If sum(kept.onChain) >
    // rewardForMiners, the overshoot equals the abandoned-debtor
    // imbalance: some miners had balance_old < 0 in a previous block
    // (bonus recipients) and never came back to offset it, so the
    // matching positive credits in the kept set no longer have a
    // backing debit to "consume" this block's freed sats.
    //
    // We cannot emit more coinbase than rewardForMiners — Bitcoin
    // Core rejects the block as bad-cb-amount. Instead of falling
    // back to fee-100 % (which would be custodial), we reduce the
    // credit-claimers' on-chain amounts proportionally to their
    // balance_old, carry the uncovered portion forward as their new
    // balance. The claim survives in the ledger and is realised when
    //   (a) the abandoned debtor comes back and offsets their debit
    //       via reduced rawFair in a future block, or
    //   (b) both sides go dormant and the dust-sweep pair-cancels.
    //
    // Active miners (shares > 0 this round) keep their full rawFair —
    // they did the work this block; they do NOT pay for someone
    // else's abandonment. Only the credit portion (balance_old > 0)
    // of any miner's on-chain takes the haircut.
    let preliminaryOnChain = 0;
    for (const c of computations.values()) preliminaryOnChain += c.onChain;

    const overshoot = preliminaryOnChain - rewardForMiners;
    if (overshoot > 0) {
        // Sort ASCENDING by balanceOld so the LARGEST credit-claimer absorbs
        // the floor-rounding residual at the end of the loop. The smallest
        // claimer's balanceOld can be < the residual when many small credits
        // share an overshoot — descending sort would push the residual onto
        // them and produce a NEGATIVE onChain, which Phase 6's emission
        // filter then drops, leaving total emitted = rewardForMiners + 1
        // sat. Bitcoin Core rejects with bad-cb-amount. Ascending sort
        // gives the residual to whoever has the most headroom for it.
        const creditClaimers = kept
            .filter(c => c.balanceOld > 0)
            .sort((a, b) => a.balanceOld - b.balanceOld);

        let totalCredit = 0;
        for (const c of creditClaimers) totalCredit += c.balanceOld;

        if (totalCredit >= overshoot && creditClaimers.length > 0) {
            let applied = 0;
            for (let i = 0; i < creditClaimers.length; i++) {
                const c = creditClaimers[i];
                let cut = (i === creditClaimers.length - 1)
                    ? overshoot - applied            // last one soaks up floor-rounding
                    : Math.floor(overshoot * c.balanceOld / totalCredit);
                // Defence-in-depth clamp: a cut must NEVER exceed the
                // claimer's available credit, otherwise c.onChain goes
                // negative and emission overshoots (see ascending-sort
                // rationale above for why this is unreachable in normal
                // configurations, but the clamp closes the door for any
                // pathological input).
                if (cut > c.balanceOld) cut = c.balanceOld;
                c.onChain -= cut;
                c.balanceNew += cut;                 // unpaid portion stays in ledger
                applied += cut;
                console.warn(
                    `${label} solvency cap: ${c.address} credit cut ${cut} sats `
                    + `(${c.onChain} on-chain, ${c.balanceNew} carry-forward — abandoned-debtor imbalance)`,
                );
            }
            // If the clamp swallowed some sats (`applied < overshoot`),
            // the cap couldn't close the gap and emission would still
            // overshoot. Fall back to fee-100 % rather than build an
            // invalid block. This branch is unreachable when totalCredit
            // >= overshoot AND ascending sort is used — kept as belt-and-
            // suspenders against future refactors.
            if (applied < overshoot) {
                console.error(
                    `${label} CRITICAL: solvency cap clamp residual ${overshoot - applied} sats `
                    + `(applied=${applied}, overshoot=${overshoot}, claimers=${creditClaimers.length}). `
                    + `Emitting fee-100 % fallback to avoid bad-cb-amount.`,
                );
                return {
                    payouts: feeAddress
                        ? [{ address: feeAddress, percent: 100, sats: blockRewardSats }]
                        : [],
                    consideredAddresses,
                    balanceAfter: new Map(),
                };
            }
        } else {
            // Mathematically impossible: overshoot > 0 ⇒ sum(kept.balance_old) > 0
            // ⇒ there must exist at least one credit-claimer with enough balance.
            // Defence in depth only.
            console.error(
                `${label} CRITICAL: overshoot ${overshoot} sats but totalCredit ${totalCredit} `
                + `insufficient (claimers: ${creditClaimers.length}). Emitting fee-100 % fallback.`,
            );
            return {
                payouts: feeAddress
                    ? [{ address: feeAddress, percent: 100, sats: blockRewardSats }]
                    : [],
                consideredAddresses,
                balanceAfter: new Map(),
            };
        }
    }

    // ── Phase 5b: residuum distribution — proportional to shares ──
    // Any remaining positive residuum (from Phase 1 floor-rounding
    // or from sub-dust miners whose rawFair stayed in their own
    // balance as a pending credit) goes to kept active miners
    // proportionally to their shares this round. Each recipient
    // also picks up a matching debit on balanceNew so the ledger
    // stays pool-neutral.
    //
    // Proportional (not "all to the largest") matters when
    // sub-dust accumulates a significant residuum — e.g. 30 sub-
    // dust miners × 50 sats each = 1 500 sats. Giving this as a
    // single lump to one active miner creates one large concentrated
    // debit that is hard to pair away; spreading it in shares-ratio
    // keeps the per-miner debit small and easier for the sweep to
    // eventually neutralise.
    let onChainTotal = 0;
    for (const c of computations.values()) onChainTotal += c.onChain;

    const residuum = rewardForMiners - onChainTotal -
        /* fee bonus from Phase 5a still needs to "fit" under the total */
        (suppressMatchingDebits ? feeBonusSats : 0);
    if (residuum > 0) {
        if (suppressMatchingDebits) {
            // Group-Solo path: donate floor-rounding residuum to fee.
            // Typical magnitude: 1–10 sats per block. No matching-debit
            // bookkeeping means member balances stay non-negative, which
            // is the whole point of Option B for C2.
            feeBonusSats += residuum;
        } else {
            const keptActive = kept.filter(c => c.shares > 0);
            let keptActiveShares = 0;
            for (const c of keptActive) keptActiveShares += c.shares;

            if (keptActiveShares > 0) {
                let assigned = 0;
                for (const c of keptActive) {
                    const bonus = Math.floor(residuum * c.shares / keptActiveShares);
                    c.onChain += bonus;
                    c.balanceNew -= bonus;
                    assigned += bonus;
                }
                const residual = residuum - assigned;
                if (residual > 0) {
                    // Floor-rounding tail (< keptActive.length sats): push
                    // to the single largest active miner so the on-chain
                    // sum exactly matches rewardForMiners.
                    const sortedByShares = [...keptActive].sort((a, b) => b.shares - a.shares);
                    sortedByShares[0].onChain += residual;
                    sortedByShares[0].balanceNew -= residual;
                }
            }
            // If no kept active miners, the residuum stays unclaimed —
            // block coinbase undershoots by that amount (rare: requires
            // kept set to be all pending-only credit-claimers).
        }
    } else if (residuum < 0) {
        // After the Phase 5a.5 solvency cap this can't happen — the
        // cap either fixed overshoot or triggered the fee-100% fallback.
        // Defence in depth only.
        console.error(
            `${label} CRITICAL: residuum ${residuum} after solvency cap. `
            + `Emitting fee-100 % fallback.`,
        );
        return {
            payouts: feeAddress
                ? [{ address: feeAddress, percent: 100, sats: blockRewardSats }]
                : [],
            consideredAddresses,
            balanceAfter: new Map(),
        };
    }

    // ── Phase 6: build payouts + balanceAfter ──────────────────────
    const payouts: CoinbaseDistributionEntry[] = [];

    // In suppressMatchingDebits mode, any sats that would normally have
    // been redistributed to active miners with a matching debit go to
    // the fee output instead. If no fee address is configured, those
    // sats are unemitted (coinbase undershoots by feeBonusSats — a
    // handful of sats; acceptable for the group-solo use case).
    const totalFeeSats = feeEmitted
        ? feeSats + (suppressMatchingDebits ? feeBonusSats : 0)
        : feeSats;
    if (feeEmitted) {
        payouts.push({
            address: feeAddress,
            percent: (totalFeeSats / blockRewardSats) * 100,
            sats: totalFeeSats,
        });
    }

    // Group-Solo finder bonus output. Emitted as its own dedicated output
    // even when the finder is also in `addressShares` — keeps the bonus
    // visible/auditable on-chain (block-explorer reviewers can see the
    // pool config in action) and the math simple. The 1-output-weight
    // overhead vs. merging into the proportional output is negligible.
    if (bonusEmitted) {
        payouts.push({
            address: finderAddress!,
            percent: (bonusSats / blockRewardSats) * 100,
            sats: bonusSats,
        });
    }

    // Sort kept miners by on-chain descending — keeps the coinbase
    // output order stable/predictable (biggest payouts first after fee).
    const sortedKept = [...kept].sort((a, b) => b.onChain - a.onChain);
    for (const c of sortedKept) {
        if (c.onChain <= 0) continue;
        payouts.push({
            address: c.address,
            percent: (c.onChain / blockRewardSats) * 100,
            sats: c.onChain,
        });
    }

    // Build balanceAfter map: include every address whose ledger state
    // either started non-zero or ends non-zero (or both). Skip purely
    // zero-in zero-out addresses to avoid DB churn.
    const balanceAfter = new Map<string, number>();
    for (const c of computations.values()) {
        if (c.balanceOld !== 0 || c.balanceNew !== 0) {
            balanceAfter.set(c.address, c.balanceNew);
        }
    }

    return {
        payouts: payouts.length > 0
            ? payouts
            : (feeAddress ? [{ address: feeAddress, percent: 100, sats: blockRewardSats }] : []),
        consideredAddresses,
        balanceAfter,
    };
}
