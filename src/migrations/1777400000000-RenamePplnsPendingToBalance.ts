import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renames `pplns_balance.pendingSats` → `pplns_balance.balanceSats`.
 *
 * The column's underlying type stays `bigint`, but the **semantics** change
 * from "always non-negative pending amount the pool owes the miner" to
 * "signed ledger balance":
 *
 *   balanceSats > 0  → Pool owes the miner this many sats (pending credit).
 *                      Same meaning as the old pendingSats.
 *   balanceSats < 0  → Miner owes the pool this many sats.
 *                      Happens when the miner received an on-chain bonus
 *                      from a trimmed/sub-dust miner's share and hasn't
 *                      yet paid it back via a reduced on-chain payout in
 *                      a subsequent block.
 *   balanceSats == 0 → No open claim in either direction.
 *
 * Pre-migration data: all existing rows have `pendingSats >= 0`, and that
 * semantic maps 1:1 to the new `balanceSats >= 0`. No data transformation
 * needed, only a column rename.
 *
 * Why this refactor exists:
 *
 * The old model absorbed sub-dust and weight-trim overflow into the pool's
 * fee output via the coinbase sweep. That meant the pool operator collected
 * the fee percent PLUS a quiet bonus from trimmed miners' shares, and the
 * trimmed miner's pending was then paid back out of future active miners'
 * cuts — an implicit cross-subsidy from Block B miners to Block A's trimmed
 * miner, with a net transfer from Miners → Fee Address. That violated the
 * pool's non-custodial positioning.
 *
 * The new model: the on-chain bonus from trimmed/sub-dust shares goes to
 * the *other active miners* in the same block (weighted by their shares),
 * and those bonus-recipient miners get a *negative* balance = they now
 * owe the pool that much, to be offset against their next on-chain
 * payout. When they come back and mine, their own fair-share shrinks by
 * exactly the bonus they received — no external miner is affected, no
 * stealth extra goes to fee. See the README section "PPLNS ledger" for
 * the full semantics.
 */
export class RenamePplnsPendingToBalance1777400000000 implements MigrationInterface {
    name = 'RenamePplnsPendingToBalance1777400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('pplns_balance');
        if (!table) return;
        const col = table.findColumnByName('pendingSats');
        if (!col) return;

        // TypeORM's renameColumn correctly preserves type, default, and
        // any indexes. No data transformation needed — old non-negative
        // pendingSats values are valid balanceSats values.
        await queryRunner.renameColumn('pplns_balance', 'pendingSats', 'balanceSats');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('pplns_balance');
        if (!table) return;
        const col = table.findColumnByName('balanceSats');
        if (!col) return;

        // Rolling back is safe in principle (column rename is trivial),
        // but if any negative balances exist at rollback time they were
        // created by the new credit/debit logic and wouldn't be valid
        // values for the old non-negative pendingSats semantic. We cap
        // negative values to 0 on rollback to keep the old code path
        // valid. The operator loses the debit information but the pool
        // remains functional on the downgraded code.
        await queryRunner.query(`UPDATE "pplns_balance" SET "balanceSats" = 0 WHERE "balanceSats" < 0`);
        await queryRunner.renameColumn('pplns_balance', 'balanceSats', 'pendingSats');
    }
}
