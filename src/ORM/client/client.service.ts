import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {


    public insertQueue: { result: BehaviorSubject<ObjectLiteral | null>, partialClient: Partial<ClientEntity> }[] = [];


    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Interval(1000 * 5)
    public async insertClients() {
        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

        queueCopy.forEach((c, index) => {
            c.result.next(results.generatedMaps[index]);
        });
    }

    public async killDeadClients() {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => 'CURRENT_TIMESTAMP' })
            .where('deletedAt IS NULL')
            .andWhere('updatedAt < :cutoff', { cutoff })
            .execute();
    }

    public async heartbeat(
        address: string,
        clientName: string,
        sessionId: string,
        hashRate: number,
        updatedAt: Date,
        currentDifficulty?: number | null,
    ) {
        const update: QueryDeepPartialEntity<ClientEntity> = {
            hashRate,
            deletedAt: null,
            updatedAt,
        };

        if (currentDifficulty !== undefined) {
            update.currentDifficulty = currentDifficulty;
        }

        return await this.clientRepository.update({ address, clientName, sessionId }, update);
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const result = new BehaviorSubject(null);

        this.insertQueue.push({ result, partialClient });


        //  const insertResult = await this.clientRepository.insert(partialClient);

        const generatedMap = await firstValueFrom(result);

        const client = {
            ...partialClient,
            ...generatedMap
        };

        return client as ClientEntity;
    }

    public async delete(sessionId: string) {
        return await this.clientRepository.softDelete({ sessionId });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository.update({ sessionId }, { bestDifficulty });
    }

    public async updateCurrentDifficulty(sessionId: string, currentDifficulty: number | null) {
        return await this.clientRepository.update({ sessionId }, { currentDifficulty });
    }

    public async updateSessionId(address: string, clientName: string, oldSessionId: string, newSessionId: string) {
        return await this.clientRepository.createQueryBuilder()
            .update(ClientEntity)
            .set({ sessionId: newSessionId })
            .where('address = :address AND clientName = :clientName AND sessionId = :oldSessionId', {
                address,
                clientName,
                oldSessionId
            })
            .execute();
    }
    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getActiveWorkerCounts(): Promise<{ addresses: number; workers: number; sessions: number }> {
        const result = await this.clientRepository
            .createQueryBuilder('client')
            .select('COUNT(DISTINCT client.address)', 'addresses')
            .addSelect("COUNT(DISTINCT client.address || '-' || client.clientName)", 'workers')
            .addSelect('COUNT(*)', 'sessions')
            .where('client.deletedAt IS NULL')
            .getRawOne<{ addresses: string; workers: string; sessions: string }>();

        return {
            addresses: Number(result?.addresses ?? 0),
            workers: Number(result?.workers ?? 0),
            sessions: Number(result?.sessions ?? 0),
        };
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getFirstSeen(address: string, clientName: string): Promise<Date | null> {
        const result = await this.clientRepository.createQueryBuilder('client')
            .withDeleted()
            .where('client.address = :address AND client.clientName = :clientName', { address, clientName })
            .orderBy('client.firstSeen', 'ASC')
            .getOne();
        if (!result) {
            return null;
        }

        const firstSeen = result.firstSeen ?? result.startTime;
        if (!firstSeen) {
            return null;
        }

        return firstSeen instanceof Date ? firstSeen : new Date(firstSeen);
    }

    public async getFirstSeenIfRecent(address: string, clientName: string, minutes = 30): Promise<Date | null> {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        const result = await this.clientRepository.createQueryBuilder('client')
            .withDeleted()
            .where('client.address = :address AND client.clientName = :clientName', { address, clientName })
            .orderBy('client.updatedAt', 'DESC')
            .getOne();

        if (result == null) {
            return null;
        }

        const lastActiveRaw: any = result.deletedAt ?? result.updatedAt;
        const lastActive = lastActiveRaw instanceof Date ? lastActiveRaw : new Date(lastActiveRaw);
        if (lastActive >= cutoff) {
            const seen = result.firstSeen ?? result.startTime;
            if (!seen) {
                return null;
            }

            return seen instanceof Date ? seen : new Date(seen);
        }
        return null;
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository.softDelete({})
    }

    public async getUserAgents() {
        const result = await this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent as userAgent')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('SUM(client.hashRate)', 'totalHashRate')
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

    public async getAllAddresses(): Promise<string[]> {
        const rows = await this.clientRepository
            .createQueryBuilder('client')
            .select('DISTINCT client.address', 'address')
            .getRawMany();
        return rows.map(r => r.address);
    }

}