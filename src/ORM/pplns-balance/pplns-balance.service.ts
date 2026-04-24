import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';

/**
 * Thin data-access layer around the PPLNS credit/debit ledger.
 *
 * Callers mutate balances in two flavors:
 *
 *   - `addBalance(address, delta)` — increments the stored balance by
 *     the signed delta. Used for incremental adjustments outside the
 *     main block-payout batch path (e.g. test fixtures, ad-hoc
 *     corrections).
 *
 *   - `setBalance(address, absolute)` — overwrites the stored balance
 *     with an absolute new value. Used by `onBlockFound`'s batch path,
 *     where the new balance comes from `buildCoinbaseDistribution`'s
 *     `balanceAfter` map. The caller reads the old balance before
 *     building the distribution and passes it in, so the absolute
 *     value is consistent with the snapshot's assumptions.
 *
 * The getters expose either a single balance or all non-zero ledger
 * rows — the latter is what `buildCoinbaseDistribution` consumes to
 * figure out who has open claims (either direction) at distribution
 * time.
 */
@Injectable()
export class PplnsBalanceService {

    constructor(
        @InjectRepository(PplnsBalanceEntity)
        private readonly repo: Repository<PplnsBalanceEntity>,
    ) {}

    /**
     * Signed delta to the stored balance. Positive grows a pending
     * credit (pool owes miner); negative grows a debit (miner owes pool).
     * Creates the row if it doesn't exist. No-op when delta is 0.
     */
    async addBalance(address: string, delta: number): Promise<void> {
        if (delta === 0) return;
        const existing = await this.repo.findOneBy({ address });
        if (existing) {
            existing.balanceSats += delta;
            await this.repo.save(existing);
        } else {
            await this.repo.save(this.repo.create({
                address,
                balanceSats: delta,
                totalPaidSats: 0,
            }));
        }
    }

    async getBalanceSats(address: string): Promise<number> {
        const entity = await this.repo.findOneBy({ address });
        return entity?.balanceSats ?? 0;
    }

    async getBalance(address: string): Promise<PplnsBalanceEntity | null> {
        return this.repo.findOneBy({ address });
    }

    /**
     * All rows with a non-zero balance (credit or debit). Consumed by
     * `buildCoinbaseDistribution` so it can factor open claims in
     * either direction into the next block's distribution.
     */
    async getAllWithBalance(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find({ where: { balanceSats: Not(0) } });
    }

    /**
     * Refresh the lastAcceptedShareAt timestamp for an existing balance
     * row. No-op when no row exists yet (miner hasn't had any balance or
     * paid activity — the abandoned-balance sweep has nothing to act on
     * anyway). Called from `PplnsService.recordShare` on every accepted
     * share; the cheap UPDATE avoids a find-then-save round-trip on the
     * hot path.
     */
    async touchLastAcceptedShareAt(address: string): Promise<void> {
        await this.repo.update({ address }, { lastAcceptedShareAt: new Date() });
    }

    /**
     * Record that `sats` were paid on-chain in this block's coinbase
     * against this miner's existing pending credit. Decrements the
     * balance toward 0 (a miner can't be paid more than they were owed
     * in a single paid-out tx) and grows the lifetime totalPaidSats
     * counter. Used for the "pending-only miner becomes eligible, paid
     * in this block" edge case; the main on-chain-with-fair-share path
     * uses `setBalance` + the history row's paidSats instead.
     */
    async markPaid(address: string, sats: number): Promise<void> {
        const entity = await this.repo.findOneBy({ address });
        if (!entity) return;
        const taken = Math.min(Math.max(0, entity.balanceSats), sats);
        entity.balanceSats -= taken;
        entity.totalPaidSats += taken;
        await this.repo.save(entity);
    }

    async getAll(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find();
    }
}
