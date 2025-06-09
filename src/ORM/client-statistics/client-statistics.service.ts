import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    constructor(


        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    public async update(clientStatistic: Partial<ClientStatisticsEntity>) {

        await this.clientStatisticsRepository.update({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time
        },
            {
                shares: clientStatistic.shares,
                acceptedCount: clientStatistic.acceptedCount,
                updatedAt: new Date()
            });

    }
    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        // If no rows were updated, insert a new record
        await this.clientStatisticsRepository.insert(clientStatistic);
    }

    public async deleteOldStatistics() {
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: oneYearAgo.getTime() })
            .execute();
    }

    public async getChartDataForSite(range: '1d' | '1m' | '6m' | '12m' = '1d') {

        let diffDays = 1;

        switch (range) {
            case '1m':
                diffDays = 30;
                break;
            case '6m':
                diffDays = 180;
                break;
            case '12m':
                diffDays = 365;
                break;
            default:
                diffDays = 1;
        }

        const since = new Date(Date.now() - diffDays * 24 * 60 * 60 * 1000);
        const limit = diffDays * 144;

        const query = `
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${since.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT ${limit};

    `;

        const result: any[] = await this.clientStatisticsRepository.query(query);


        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1)

    }


    // public async getHashRateForAddress(address: string) {

    //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

    //     const query = `
    //         SELECT
    //         SUM(entry.shares) AS difficultySum
    //         FROM
    //             client_statistics_entity AS entry
    //         WHERE
    //             entry.address = ? AND entry.time > ${oneHour}
    //     `;

    //     const result = await this.clientStatisticsRepository.query(query, [address]);

    //     const difficultySum = result[0].difficultySum;

    //     return (difficultySum * 4294967296) / (600);

    // }

    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    time label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = ? AND entry.time > ${yesterday.getTime()}
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

        const result = await this.clientStatisticsRepository.query(query, [address]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${oneHour.getTime()}
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                createdAt,
                updatedAt,
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            ORDER BY time DESC
            LIMIT 2;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return (latestStat.shares * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return ((latestStat.shares + secondLatestStat.shares) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async getTotalSharesForAddress(address: string): Promise<number> {
        const result = await this.clientStatisticsRepository
            .createQueryBuilder('entry')
            .select('SUM(entry.shares)', 'total')
            .where('entry.address = :address', { address })
            .getRawOne();
        return result?.total ? parseFloat(result.total) : 0;
    }

    public async getTotalSharesForWorkers(address: string): Promise<Array<{ clientName: string, total: number }>> {
        const results = await this.clientStatisticsRepository
            .createQueryBuilder('entry')
            .select('entry.clientName', 'clientName')
            .addSelect('SUM(entry.shares)', 'total')
            .where('entry.address = :address', { address })
            .groupBy('entry.clientName')
            .getRawMany();
        return results.map(r => ({ clientName: r.clientName, total: parseFloat(r.total) }));
    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}