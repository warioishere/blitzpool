import { Column, Entity, PrimaryColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

@Entity('pplns_balance')
export class PplnsBalanceEntity {

    @PrimaryColumn({ type: 'varchar', length: 62 })
    address: string;

    /**
     * Signed ledger balance for this PPLNS miner.
     *
     *   > 0  → Pool owes the miner this many sats (pending credit —
     *          accumulated from sub-dust rounds or weight-trimmed blocks
     *          where their on-chain output didn't fit, waiting to be
     *          absorbed into a future block's coinbase).
     *
     *   < 0  → Miner owes the pool this many sats (pending debit — they
     *          received an on-chain bonus from another miner's trim or
     *          sub-dust in a previous block, to be offset against their
     *          next on-chain payout when they're active in a future
     *          block's coinbase).
     *
     *   = 0  → No open claim in either direction.
     *
     * The sum of all `balanceSats` across all miners should be 0 in a
     * steady-state pool with no abandonment — every trim bonus a miner
     * received has a matching debit somewhere else. When a miner becomes
     * inactive for the abandonment period (see DustSweepService), their
     * non-zero balance is zeroed out by the sweep: positive balances
     * implicitly redistribute to active miners via a larger
     * effectiveMinerReward in the next block; negative balances are
     * absorbed as pool loss.
     *
     * Stored as `bigint` in Postgres which supports negative values
     * natively. The transformer handles the bigint-as-string ↔ number
     * mapping typical for TypeORM+pg.
     */
    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    balanceSats: number;

    @Column({ type: 'bigint', default: 0, transformer: { from: (v: string) => Number(v), to: (v: number) => v } })
    totalPaidSats: number;

    /**
     * Last accepted-share timestamp for this address (on the PPLNS path),
     * stored as epoch milliseconds. Updated by PplnsService.recordShare.
     * Primary driver for the abandoned-balance sweep cron: rows whose
     * `balanceSats != 0` and whose `lastAcceptedShareAt` is older than
     * the configured abandonment period get their balance zeroed out.
     *
     * Nullable because pre-existing rows at migration time have no
     * timestamp — those are treated as "active" until they eventually
     * update or get swept once they truly go inactive.
     */
    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    lastAcceptedShareAt: number | null;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    updatedAt: number;
}
