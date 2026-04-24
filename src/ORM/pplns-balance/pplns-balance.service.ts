import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';

/**
 * Thin data-access layer around the PPLNS credit/debit ledger.
 *
 * The only supported write path is `onBlockFound`'s batch write:
 * `buildCoinbaseDistribution` returns a `balanceAfter` map of absolute
 * post-block balances, and the block-found transaction UPSERTs those
 * values directly (via the repository). There is no incremental
 * `addBalance(delta)` or `markPaid(sats)` helper because both would
 * race with the atomic absolute-write pattern used on the hot path —
 * two independent paths writing the same row is exactly the kind of
 * ledger drift the signed-ledger refactor was designed to rule out.
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

    async getAll(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find();
    }
}
