import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { IsNull, ObjectLiteral, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ClientEntity } from './client.entity';

interface BufferedHeartbeat {
    address: string;
    clientName: string;
    sessionId: string;
    hashRate: number;
    updatedAt: Date;
    currentDifficulty?: number | null;
}

@Injectable()
export class ClientService implements OnModuleDestroy {


    public insertQueue: { result: BehaviorSubject<ObjectLiteral | null>, partialClient: Partial<ClientEntity> }[] = [];

    /** Heartbeat buffer: sessionId → latest heartbeat data */
    private heartbeatBuffer = new Map<string, BufferedHeartbeat>();


    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Interval(1000 * 5)
    public async insertClients() {
        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        if (queueCopy.length === 0) return;

        try {
            const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

            queueCopy.forEach((c, index) => {
                c.result.next(results.generatedMaps[index]);
            });
        } catch (error) {
            console.error(`insertClients failed for ${queueCopy.length} clients:`, error);
            // Signal error to all waiting callers so they can handle it
            // (firstValueFrom will reject, and the StratumClient will catch and close)
            queueCopy.forEach(c => {
                c.result.error(error);
            });
        }
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

    async onModuleDestroy(): Promise<void> {
        await this.flushHeartbeats();
    }

    /**
     * Buffer a heartbeat — only the latest per sessionId is kept.
     * Flushed as batch UPDATE every 30 seconds.
     */
    public async heartbeat(
        address: string,
        clientName: string,
        sessionId: string,
        hashRate: number,
        updatedAt: Date,
        currentDifficulty?: number | null,
    ) {
        this.heartbeatBuffer.set(sessionId, {
            address, clientName, sessionId, hashRate, updatedAt, currentDifficulty,
        });
    }

    /**
     * Flush buffered heartbeats. Postgres path issues one bulk UPDATE …
     * FROM unnest(...) so all buffered sessions land in a single statement
     * instead of N sequential UPDATEs. Sqlite (dev/test) keeps the per-row
     * loop — pg-mem doesn't speak parallel-array unnest, and sqlite is
     * not performance-critical.
     */
    @Interval(30_000)
    public async flushHeartbeats(): Promise<void> {
        if (this.heartbeatBuffer.size === 0) return;

        const snapshot = this.heartbeatBuffer;
        this.heartbeatBuffer = new Map();

        try {
            const dbType = this.clientRepository.manager.connection.options.type;
            if (dbType === 'postgres') {
                await this.flushHeartbeatsBulkPostgres(snapshot);
            } else {
                await this.flushHeartbeatsPerRow(snapshot);
            }
        } catch (error) {
            // Re-buffer on failure (keep newer values if buffer already has entries)
            for (const [sid, hb] of snapshot) {
                if (!this.heartbeatBuffer.has(sid)) {
                    this.heartbeatBuffer.set(sid, hb);
                }
            }
            console.error(`[ClientService] flushHeartbeats failed for ${snapshot.size} clients:`, error);
        }
    }

    private async flushHeartbeatsBulkPostgres(snapshot: Map<string, BufferedHeartbeat>): Promise<void> {
        const addresses: string[] = [];
        const clientNames: string[] = [];
        const sessionIds: string[] = [];
        const hashRates: number[] = [];
        const updatedAts: Date[] = [];
        const updateDiffFlags: boolean[] = [];
        const currentDifficulties: (number | null)[] = [];

        for (const hb of snapshot.values()) {
            addresses.push(hb.address);
            clientNames.push(hb.clientName);
            sessionIds.push(hb.sessionId);
            hashRates.push(hb.hashRate);
            updatedAts.push(hb.updatedAt);
            if (hb.currentDifficulty !== undefined) {
                updateDiffFlags.push(true);
                currentDifficulties.push(hb.currentDifficulty);
            } else {
                updateDiffFlags.push(false);
                currentDifficulties.push(null);
            }
        }

        const query = `
            UPDATE client_entity AS t
            SET "hashRate" = u."hashRate",
                "deletedAt" = NULL,
                "updatedAt" = u."updatedAt",
                "currentDifficulty" = CASE WHEN u."updateDiff" THEN u."currentDifficulty" ELSE t."currentDifficulty" END
            FROM (
                SELECT
                    unnest($1::text[]) AS address,
                    unnest($2::text[]) AS "clientName",
                    unnest($3::text[]) AS "sessionId",
                    unnest($4::double precision[]) AS "hashRate",
                    unnest($5::timestamptz[]) AS "updatedAt",
                    unnest($6::boolean[]) AS "updateDiff",
                    unnest($7::real[]) AS "currentDifficulty"
            ) AS u
            WHERE t.address = u.address
              AND t."clientName" = u."clientName"
              AND t."sessionId" = u."sessionId"
        `;
        await this.clientRepository.query(query, [
            addresses, clientNames, sessionIds, hashRates, updatedAts, updateDiffFlags, currentDifficulties,
        ]);
    }

    private async flushHeartbeatsPerRow(snapshot: Map<string, BufferedHeartbeat>): Promise<void> {
        await this.clientRepository.manager.transaction(async (manager) => {
            const repo = manager.getRepository(ClientEntity);
            for (const hb of snapshot.values()) {
                const update: QueryDeepPartialEntity<ClientEntity> = {
                    hashRate: hb.hashRate,
                    deletedAt: null,
                    updatedAt: hb.updatedAt,
                };
                if (hb.currentDifficulty !== undefined) {
                    update.currentDifficulty = hb.currentDifficulty;
                }
                await repo.update(
                    { address: hb.address, clientName: hb.clientName, sessionId: hb.sessionId },
                    update,
                );
            }
        });
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

    public async updateUserAgentByAddress(address: string, oldUserAgent: string, newUserAgent: string): Promise<number> {
        const result = await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ userAgent: newUserAgent })
            .where('address = :address AND userAgent = :oldUserAgent', { address, oldUserAgent })
            .execute();
        return result.affected || 0;
    }

    public async updateUserAgent(sessionId: string, userAgent: string): Promise<void> {
        await this.clientRepository.update({ sessionId }, { userAgent });
    }

    public async updateSv2UserAgentByAddress(address: string, newUserAgent: string): Promise<number> {
        const result = await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ userAgent: newUserAgent })
            .where('address = :address AND userAgent IN (:...agents)', { address, agents: ['jd-client/sv2', '/sv2'] })
            .execute();
        return result.affected || 0;
    }

    public async resetBestDifficultyForAddress(address: string): Promise<void> {
        await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ bestDifficulty: 0 })
            .where('address = :address', { address })
            .execute();
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
        return await this.clientRepository.count({ where: { deletedAt: IsNull() } });
    }

    public async getActiveWorkerCounts(): Promise<{ addresses: number; workers: number }> {
        const result = await this.clientRepository
            .createQueryBuilder('client')
            .select('COUNT(DISTINCT client.address)', 'addresses')
            .addSelect("COUNT(DISTINCT client.address || '-' || client.clientName)", 'workers')
            .where('client.deletedAt IS NULL')
            .getRawOne<{ addresses: string; workers: string }>();

        return {
            addresses: Number(result?.addresses ?? 0),
            workers: Number(result?.workers ?? 0),
        };
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }

    /**
     * Hot-path lookup for the `GET /api/client/:address` dashboard
     * endpoint (polled every few seconds per active miner).
     *
     * Why this exists separately from `getByAddress()`:
     *   ClientEntity has 5 Date columns (`startTime`, `firstSeen`,
     *   `createdAt`, `updatedAt`, `deletedAt`). The default `.find()` path
     *   fetches all 12 columns and runs each row through TypeORM's
     *   RawSqlResultsToEntityTransformer (transformColumns → setEntityValue
     *   → `DateTimeTransformer.from` for every Date column). On prod the
     *   2026-05-13 CPU profile attributed ~25-30 % of non-idle CPU to
     *   TypeORM entity hydration, with `postgres-date.parseDate` alone at
     *   3.59 %. This method sidesteps both:
     *     1. SELECT only the 7 columns the controller actually uses.
     *     2. Use a raw query so TypeORM never builds an entity (no
     *        transformer chain, no per-row entity constructor).
     *
     * Sqlite path keeps the entity-based query — sqlite is dev/test only,
     * perf doesn't matter there, and the shape compatibility is preserved
     * because the controller accesses the same 7 field names either way.
     */
    public async getByAddressLight(address: string): Promise<Array<{
        sessionId: string;
        clientName: string;
        bestDifficulty: number;
        hashRate: number;
        currentDifficulty: number | null;
        startTime: Date;
        updatedAt: Date;
    }>> {
        if (this.clientRepository.manager.connection.options.type === 'postgres') {
            return this.clientRepository.query(
                `SELECT "sessionId", "clientName", "bestDifficulty", "hashRate",
                        "currentDifficulty", "startTime", "updatedAt"
                 FROM client_entity
                 WHERE address = $1 AND "deletedAt" IS NULL`,
                [address],
            );
        }
        // Sqlite / pg-mem fallback: TypeORM-portable entity query. Returns
        // the full entity; the controller picks the 7 fields it needs from
        // either shape interchangeably.
        return this.clientRepository.find({ where: { address } }) as unknown as Promise<any>;
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

    public async getUserAgents(excludeAddresses?: string[]) {
        const qb = this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent', 'userAgent')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('SUM(client.hashRate)', 'totalHashRate');

        if (excludeAddresses && excludeAddresses.length > 0) {
            qb.where('client.address NOT IN (:...excludeAddresses)', { excludeAddresses });
        }

        const result = await qb
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

    public async getTotalHashrateForAddresses(addresses: string[]): Promise<number> {
        if (!addresses || addresses.length === 0) return 0;
        const result = await this.clientRepository.createQueryBuilder('client')
            .select('COALESCE(SUM(client.hashRate), 0)', 'totalHashRate')
            .where('client.address IN (:...addresses)', { addresses })
            .getRawOne();
        return parseFloat(result?.totalHashRate ?? '0');
    }

    /** Same aggregation as `getUserAgents` but restricted to a specific set of addresses. */
    public async getUserAgentsForAddresses(addresses: string[]) {
        if (!addresses || addresses.length === 0) return [];
        return await this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent', 'userAgent')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('SUM(client.hashRate)', 'totalHashRate')
            .where('client.address IN (:...addresses)', { addresses })
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
    }

    public async getAllAddresses(): Promise<string[]> {
        const rows = await this.clientRepository
            .createQueryBuilder('client')
            .select('DISTINCT client.address', 'address')
            .getRawMany();
        return rows.map(r => r.address);
    }

    public async hardDeleteForAddress(address: string): Promise<void> {
        await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('address = :address', { address })
            .execute();
    }

}