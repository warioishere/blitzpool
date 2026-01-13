import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AddressSettingsEntity } from './address-settings.entity';

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
            // It's possible to have a race condition here so if we get a PK violation, fetch it
            try {
                settings = await this.createNew(address);
            } catch (e) {
                settings = await this.addressSettingsRepository
                    .createQueryBuilder('settings')
                    .where('settings.address = :address', { address })
                    .getOne();
            }
        }

        return settings;
    }

    public async updateBestDifficulty(address: string, bestDifficulty: number, bestDifficultyUserAgent: string) {
        return await this.addressSettingsRepository.update({ address }, { bestDifficulty, bestDifficultyUserAgent });
    }

    public async getHighScores() {
        return await this.addressSettingsRepository
            .createQueryBuilder('settings')
            .select([
                'settings.updatedAt AS "updatedAt"',
                'settings.bestDifficulty AS "bestDifficulty"',
                'settings.bestDifficultyUserAgent AS "bestDifficultyUserAgent"',
            ])
            .orderBy('settings.bestDifficulty', 'DESC')
            .limit(10)
            .getRawMany();
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
     * Bulk update shares for multiple addresses in a single transaction
     * MUCH faster than calling addShares() individually for each address
     * @param updates Array of {address, shares} to update
     */
    public async addSharesBulk(updates: Array<{ address: string; shares: number }>) {
        if (updates.length === 0) {
            return;
        }

        // Detect database type to use correct placeholder syntax
        const databaseType = this.addressSettingsRepository.manager.connection.options.type;

        if (databaseType === 'postgres') {
            // PostgreSQL: Use $1, $2, $3... placeholders
            const caseWhenParts: string[] = [];
            const parameters: any[] = [];
            let paramIndex = 1;

            updates.forEach((update) => {
                caseWhenParts.push(`WHEN $${paramIndex} THEN $${paramIndex + 1}`);
                parameters.push(update.address, update.shares);
                paramIndex += 2;
            });

            // WHERE IN clause with $N placeholders
            const whereClause = updates.map((_, idx) => `$${paramIndex + idx}`).join(',');
            const whereAddresses = updates.map(u => u.address);

            const query = `
                UPDATE address_settings_entity
                SET shares = shares + CASE address ${caseWhenParts.join(' ')} END
                WHERE address IN (${whereClause})
            `;

            // Execute as SINGLE atomic transaction
            await this.addressSettingsRepository.query(query, [
                ...parameters,
                ...whereAddresses
            ]);
        } else {
            // SQLite: Use ? placeholders
            // SQLite 3.40+ supports 32,766 parameters (we use ~800 for 400 addresses)
            const caseWhenParts: string[] = [];
            const parameters: any[] = [];

            updates.forEach((update) => {
                caseWhenParts.push(`WHEN ? THEN ?`);
                parameters.push(update.address, update.shares);
            });

            // Add addresses for WHERE IN clause
            const placeholders = updates.map(() => '?').join(',');
            const whereAddresses = updates.map(u => u.address);

            const query = `
                UPDATE address_settings_entity
                SET shares = shares + CASE address ${caseWhenParts.join(' ')} END
                WHERE address IN (${placeholders})
            `;

            // Execute as SINGLE atomic transaction
            await this.addressSettingsRepository.query(query, [
                ...parameters,
                ...whereAddresses
            ]);
        }
    }

    public async resetBestDifficultyAndShares() {
        return await this.addressSettingsRepository.update({}, {
            shares: 0,
            bestDifficulty: 0
        });
    }

    public async deleteForAddress(address: string) {
        return await this.addressSettingsRepository.delete({ address });
    }
}