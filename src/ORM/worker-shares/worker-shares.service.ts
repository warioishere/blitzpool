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

    public async getWorkerTotals(address: string): Promise<Array<{ clientName: string; shares: number }>> {
        return this.repo.find({ where: { address } });
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
                INSERT INTO worker_shares_entity (address, "clientName", shares)
                SELECT address, "clientName", SUM(shares) as shares
                FROM client_statistics_entity
                GROUP BY address, "clientName"
                HAVING SUM(shares) > 0
            `);
        } else {
            await this.dataSource.query(`
                INSERT INTO worker_shares_entity (address, clientName, shares)
                SELECT address, clientName, SUM(shares) as shares
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
        updates: Array<{ address: string; clientName: string; shares: number }>,
    ): Promise<void> {
        if (updates.length === 0) return;

        const dataSource = this.repo.manager.connection;

        if (dataSource.options.type === 'postgres') {
            // Process in batches of 1000 to stay within PG parameter limits (3 params × 1000 = 3000)
            const BATCH_SIZE = 1000;
            for (let i = 0; i < updates.length; i += BATCH_SIZE) {
                const batch = updates.slice(i, i + BATCH_SIZE);
                const values = batch
                    .map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::double precision)`)
                    .join(', ');
                const params = batch.flatMap(u => [u.address, u.clientName, u.shares]);

                await dataSource.query(
                    `INSERT INTO worker_shares_entity (address, "clientName", shares)
                     VALUES ${values}
                     ON CONFLICT (address, "clientName") DO UPDATE SET
                       shares = worker_shares_entity.shares + EXCLUDED.shares`,
                    params,
                );
            }
        } else {
            for (const u of updates) {
                const existing = await this.repo.findOne({
                    where: { address: u.address, clientName: u.clientName },
                });
                if (existing) {
                    existing.shares += u.shares;
                    await this.repo.save(existing);
                } else {
                    await this.repo.save({ address: u.address, clientName: u.clientName, shares: u.shares });
                }
            }
        }
    }
}
