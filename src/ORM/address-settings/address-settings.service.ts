import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AddressSettingsEntity } from './address-settings.entity';
import { isoFromEpoch } from '../../utils/epoch-iso';

@Injectable()
export class AddressSettingsService {

    constructor(
        @InjectRepository(AddressSettingsEntity)
        private addressSettingsRepository: Repository<AddressSettingsEntity>
    ) {

    }

    public async getSettings(address: string, createIfNotFound: boolean) {
        let settings = await this.addressSettingsRepository
            .createQueryBuilder('settings')
            .where('settings.address = :address', { address })
            .getOne();

        if (createIfNotFound === true && settings == null) {
            // Atomic upsert — no race condition. createdAt/updatedAt set
            // explicitly because createQueryBuilder().insert() bypasses
            // the @BeforeInsert hook on TrackedEntity.
            const now = Date.now();
            await this.addressSettingsRepository
                .createQueryBuilder()
                .insert()
                .into(AddressSettingsEntity)
                .values({ address, createdAt: now, updatedAt: now })
                .orIgnore()
                .execute();
            settings = await this.addressSettingsRepository
                .createQueryBuilder('settings')
                .where('settings.address = :address', { address })
                .getOne();
        }

        return settings;
    }

    /**
     * Hot-path lookup that returns just the (bestDifficulty,
     * bestDifficultyUserAgent) pair — what AddressSettingsCacheService
     * needs on a Redis cache miss. Skips entity hydration; raw SELECT
     * on Postgres.
     */
    public async getBestDifficultyLight(
        address: string,
    ): Promise<{ bestDifficulty: number; bestDifficultyUserAgent: string | null } | null> {
        if (this.addressSettingsRepository.manager.connection.options.type === 'postgres') {
            const rows: Array<{ bestDifficulty: number | string | null; bestDifficultyUserAgent: string | null }> =
                await this.addressSettingsRepository.query(
                    `SELECT "bestDifficulty", "bestDifficultyUserAgent"
                     FROM address_settings_entity
                     WHERE address = $1
                     LIMIT 1`,
                    [address],
                );
            if (!rows[0]) return null;
            const v = rows[0].bestDifficulty;
            const n = typeof v === 'number' ? v : (v == null ? 0 : Number(v));
            return {
                bestDifficulty: Number.isFinite(n) ? n : 0,
                bestDifficultyUserAgent: rows[0].bestDifficultyUserAgent ?? null,
            };
        }
        const settings = await this.addressSettingsRepository.findOne({ where: { address } });
        return settings
            ? { bestDifficulty: settings.bestDifficulty ?? 0, bestDifficultyUserAgent: settings.bestDifficultyUserAgent ?? null }
            : null;
    }

    /**
     * Hot-path helper for the per-minute push-notification cron. Returns
     * only the `bestDifficulty` column for the given addresses in a single
     * raw SELECT on Postgres (no entity hydration), keyed for O(1) lookup
     * via address. Missing addresses are absent from the map.
     */
    public async getBestDifficultiesForAddresses(addresses: string[]): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        if (addresses.length === 0) return out;
        const dbType = this.addressSettingsRepository.manager.connection.options.type;
        if (dbType === 'postgres') {
            const rows: Array<{ address: string; bestDifficulty: number | string | null }> =
                await this.addressSettingsRepository.query(
                    `SELECT address, "bestDifficulty"
                     FROM address_settings_entity
                     WHERE address = ANY($1::text[])`,
                    [addresses],
                );
            for (const row of rows) {
                const v = row.bestDifficulty;
                const n = typeof v === 'number' ? v : (v == null ? 0 : Number(v));
                out.set(row.address, Number.isFinite(n) ? n : 0);
            }
            return out;
        }
        const rows = await this.addressSettingsRepository.find({
            where: { address: In(addresses) },
        });
        for (const row of rows) {
            out.set(row.address, row.bestDifficulty ?? 0);
        }
        return out;
    }

    public async updateBestDifficulty(address: string, bestDifficulty: number, bestDifficultyUserAgent: string) {
        return await this.addressSettingsRepository.update({ address }, { bestDifficulty, bestDifficultyUserAgent });
    }

    public async getHighScores() {
        const results = await this.addressSettingsRepository
            .createQueryBuilder('settings')
            .select([
                'settings.updatedAt AS "updatedAt"',
                'settings.bestDifficulty AS "bestDifficulty"',
                'settings.bestDifficultyUserAgent AS "bestDifficultyUserAgent"',
            ])
            .orderBy('settings.bestDifficulty', 'DESC')
            .limit(10)
            .getRawMany();
        // getRawMany returns bigint columns as strings (pg-types default) —
        // coerce to ISO at the boundary so /api/info emits real timestamps,
        // not raw epoch-ms numerals.
        return results.map(r => ({
            ...r,
            bestDifficulty: Number(r.bestDifficulty),
            updatedAt: isoFromEpoch(r.updatedAt == null ? null : Number(r.updatedAt)),
        }));
    }

    public async createNew(address: string) {
        return await this.addressSettingsRepository.save({ address });
    }

    public async addShares(address: string, shares: number) {
        // Explicitly preserve updatedAt to prevent TypeORM from automatically updating it
        // We only want updatedAt to change when bestDifficulty changes, not when shares accumulate
        return await this.addressSettingsRepository
            .createQueryBuilder()
            .update(AddressSettingsEntity)
            .set({
                shares: () => 'shares + :increment',
                updatedAt: () => '"updatedAt"',  // Preserve current value
            })
            .where('address = :address', { address })
            .setParameters({ increment: shares })
            .execute();
    }

    /**
     * Bulk update shares for multiple addresses in a single transaction.
     * Parallel-array params (addresses[i] gets deltas[i] added) skip the
     * record-array allocation step in the caller.
     */
    public async addSharesBulk(addresses: string[], deltas: number[]) {
        if (addresses.length === 0) {
            return;
        }

        const databaseType = this.addressSettingsRepository.manager.connection.options.type;

        if (databaseType === 'postgres') {
            const query = `
                UPDATE address_settings_entity AS t
                SET shares = t.shares + d.delta
                FROM (SELECT unnest($1::text[]) AS address, unnest($2::double precision[]) AS delta) AS d
                WHERE t.address = d.address
            `;

            await this.addressSettingsRepository.query(query, [addresses, deltas]);
        } else {
            const n = addresses.length;
            const caseWhenParts: string[] = new Array(n);
            const placeholders: string[] = new Array(n);
            const parameters: any[] = new Array(n * 3);
            for (let i = 0; i < n; i++) {
                caseWhenParts[i] = 'WHEN ? THEN ?';
                parameters[i * 2] = addresses[i];
                parameters[i * 2 + 1] = deltas[i];
                placeholders[i] = '?';
            }
            for (let i = 0; i < n; i++) {
                parameters[n * 2 + i] = addresses[i];
            }

            const query = `
                UPDATE address_settings_entity
                SET shares = shares + CASE address ${caseWhenParts.join(' ')} END
                WHERE address IN (${placeholders.join(',')})
            `;

            await this.addressSettingsRepository.query(query, parameters);
        }
    }

    public async deleteForAddress(address: string) {
        return await this.addressSettingsRepository.delete({ address });
    }
}