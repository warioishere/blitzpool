import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { PplnsBalanceEntity } from './pplns-balance.entity';

@Injectable()
export class PplnsBalanceService {

    constructor(
        @InjectRepository(PplnsBalanceEntity)
        private readonly repo: Repository<PplnsBalanceEntity>,
    ) {}

    async addPending(address: string, sats: number): Promise<void> {
        const existing = await this.repo.findOneBy({ address });
        if (existing) {
            existing.pendingSats += sats;
            await this.repo.save(existing);
        } else {
            await this.repo.save(this.repo.create({
                address,
                pendingSats: sats,
                totalPaidSats: 0,
            }));
        }
    }

    async getPending(address: string): Promise<number> {
        const entity = await this.repo.findOneBy({ address });
        return entity?.pendingSats ?? 0;
    }

    async getBalance(address: string): Promise<PplnsBalanceEntity | null> {
        return this.repo.findOneBy({ address });
    }

    async getAllWithPending(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find({ where: { pendingSats: MoreThan(0) } });
    }

    async markPaid(address: string, sats: number): Promise<void> {
        const entity = await this.repo.findOneBy({ address });
        if (!entity) return;
        entity.pendingSats = Math.max(0, entity.pendingSats - sats);
        entity.totalPaidSats += sats;
        await this.repo.save(entity);
    }

    async getAll(): Promise<PplnsBalanceEntity[]> {
        return this.repo.find();
    }
}
