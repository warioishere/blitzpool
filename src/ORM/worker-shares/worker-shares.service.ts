import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { WorkerSharesEntity } from './worker-shares.entity';

@Injectable()
export class WorkerSharesService {
    constructor(
        @InjectRepository(WorkerSharesEntity)
        private readonly repo: Repository<WorkerSharesEntity>,
        private readonly dataSource: DataSource,
    ) {}

    public async getWorkerTotals(address: string): Promise<Array<{ clientName: string; shares: number; rejectedShares: number }>> {
        return this.repo.find({ where: { address } });
    }

    /**
     * Hot-path lookup used by `GET /api/client/:address/worker-shares`.
     * Caller only needs `clientName` + `rejectedShares` (the `shares`
     * total comes from `ShareTotalsCacheService.getWorkerTotals`).
     *
     * Although `WorkerSharesEntity` has no Date columns (so no
     * `parseDate` cost), bypassing TypeORM's entity hydration still
     * skips the per-row constructor + transformColumns loop. The win is
     * smaller than for `ClientService.getByAddressLight` but the pattern
     * is the same — raw query on Postgres, entity fallback on sqlite/
     * pg-mem (dev/test).
     */
    public async getWorkerTotalsLight(address: string): Promise<Array<{ clientName: string; rejectedShares: number }>> {
        if (this.dataSource.options.type === 'postgres') {
            return this.dataSource.query(
                `SELECT "clientName", "rejectedShares"
                 FROM worker_shares_entity
                 WHERE address = $1`,
                [address],
            );
        }
        // Sqlite / pg-mem fallback — controller reads only the two
        // fields above from each row.
        return this.repo.find({ where: { address } }) as unknown as Promise<any>;
    }

    /**
     * Seed from client_statistics_entity if worker_shares_entity is empty.
     * Runs once on first deploy to backfill cumulative totals.
     */
    public async seedIfEmpty(): Promise<void> {
        const count = await this.repo.count();
        if (count > 0) return;

        console.log('[WorkerShares] Table is empty, seeding from client_statistics_entity...');

        if (this.dataSource.options.type === 'postgres') {
            await this.dataSource.query(`
                INSERT INTO worker_shares_entity (address, "clientName", shares, "rejectedShares")
                SELECT address, "clientName",
                    SUM(shares),
                    SUM(COALESCE("rejectedJobNotFoundDiff1", 0) + COALESCE("rejectedDuplicateShareDiff1", 0) + COALESCE("rejectedLowDifficultyShareDiff1", 0))
                FROM client_statistics_entity
                GROUP BY address, "clientName"
                HAVING SUM(shares) > 0
            `);
        } else {
            await this.dataSource.query(`
                INSERT INTO worker_shares_entity (address, clientName, shares, rejectedShares)
                SELECT address, clientName,
                    SUM(shares),
                    SUM(COALESCE(rejectedJobNotFoundDiff1, 0) + COALESCE(rejectedDuplicateShareDiff1, 0) + COALESCE(rejectedLowDifficultyShareDiff1, 0))
                FROM client_statistics_entity
                GROUP BY address, clientName
                HAVING SUM(shares) > 0
            `);
        }

        const seeded = await this.repo.count();
        console.log(`[WorkerShares] Seeded ${seeded} worker totals`);
    }

    public async deleteForAddress(address: string): Promise<void> {
        await this.repo.delete({ address });
    }

    public async addSharesBulk(
        addresses: string[],
        clientNames: string[],
        shares: number[],
    ): Promise<void> {
        if (addresses.length === 0) return;

        const dataSource = this.repo.manager.connection;

        if (dataSource.options.type === 'postgres') {
            // unnest() with parallel arrays — single round-trip, no
            // batching needed. Three array params instead of N×3
            // positional binds; statement size is constant. See
            // StatisticsCoordinatorService.bulkUpsertClientStatistics
            // for the wider rationale (~9× speedup measured on prod
            // hardware for ~1500-row inserts).
            await dataSource.query(
                `INSERT INTO worker_shares_entity (address, "clientName", shares)
                 SELECT * FROM unnest($1::text[], $2::text[], $3::double precision[])
                 ON CONFLICT (address, "clientName") DO UPDATE SET
                   shares = worker_shares_entity.shares + EXCLUDED.shares`,
                [addresses, clientNames, shares],
            );
        } else {
            for (let i = 0; i < addresses.length; i++) {
                const existing = await this.repo.findOne({
                    where: { address: addresses[i], clientName: clientNames[i] },
                });
                if (existing) {
                    existing.shares += shares[i];
                    await this.repo.save(existing);
                } else {
                    await this.repo.save({ address: addresses[i], clientName: clientNames[i], shares: shares[i] });
                }
            }
        }
    }

    /**
     * Increment rejected share totals per worker in bulk.
     * Called by StatisticsCoordinator after each successful client-statistics flush.
     */
    public async addRejectedBulk(
        addresses: string[],
        clientNames: string[],
        rejectedShares: number[],
    ): Promise<void> {
        if (addresses.length === 0) return;

        const dataSource = this.repo.manager.connection;

        if (dataSource.options.type === 'postgres') {
            const n = addresses.length;
            const zeroShares: number[] = new Array(n).fill(0);

            await dataSource.query(
                `INSERT INTO worker_shares_entity (address, "clientName", shares, "rejectedShares")
                 SELECT * FROM unnest($1::text[], $2::text[], $3::double precision[], $4::double precision[])
                 ON CONFLICT (address, "clientName") DO UPDATE SET
                   "rejectedShares" = worker_shares_entity."rejectedShares" + EXCLUDED."rejectedShares"`,
                [addresses, clientNames, zeroShares, rejectedShares],
            );
        } else {
            for (let i = 0; i < addresses.length; i++) {
                const existing = await this.repo.findOne({
                    where: { address: addresses[i], clientName: clientNames[i] },
                });
                if (existing) {
                    existing.rejectedShares += rejectedShares[i];
                    await this.repo.save(existing);
                } else {
                    await this.repo.save({ address: addresses[i], clientName: clientNames[i], shares: 0, rejectedShares: rejectedShares[i] });
                }
            }
        }
    }
}
