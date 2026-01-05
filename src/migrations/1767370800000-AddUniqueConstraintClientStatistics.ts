import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueConstraintClientStatistics1767370800000
    implements MigrationInterface
{
    name = 'AddUniqueConstraintClientStatistics1767370800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;

        if (dbType === 'postgres') {
            // PostgreSQL: Add unique constraint
            try {
                // Check if constraint already exists
                const existingConstraint = await queryRunner.query(`
                    SELECT constraint_name
                    FROM information_schema.table_constraints
                    WHERE table_name = 'client_statistics_entity'
                    AND constraint_name = 'UQ_client_statistics_composite'
                `);

                if (existingConstraint && existingConstraint.length > 0) {
                    console.log('[Migration] UNIQUE constraint already exists, skipping');
                    return;
                }

                // Safely handle duplicates by accumulating shares instead of deleting
                console.log('[Migration] Checking for duplicates...');
                const duplicates = await queryRunner.query(`
                    SELECT address, "clientName", "sessionId", time, COUNT(*) as count
                    FROM client_statistics_entity
                    GROUP BY address, "clientName", "sessionId", time
                    HAVING COUNT(*) > 1
                `);

                if (duplicates && duplicates.length > 0) {
                    console.log(`[Migration] Found ${duplicates.length} duplicate groups, deduplicating...`);

                    // For each duplicate group, sum the shares and keep one record
                    for (const dup of duplicates) {
                        await queryRunner.query(`
                            WITH aggregated AS (
                                SELECT
                                    MIN(id) as keep_id,
                                    SUM(shares) as total_shares,
                                    SUM("acceptedCount") as total_accepted,
                                    SUM("rejectedCount") as total_rejected,
                                    SUM("rejectedJobNotFoundCount") as total_jnf_count,
                                    SUM("rejectedJobNotFoundDiff1") as total_jnf_diff,
                                    SUM("rejectedDuplicateShareCount") as total_dup_count,
                                    SUM("rejectedDuplicateShareDiff1") as total_dup_diff,
                                    SUM("rejectedLowDifficultyShareCount") as total_low_count,
                                    SUM("rejectedLowDifficultyShareDiff1") as total_low_diff
                                FROM client_statistics_entity
                                WHERE address = $1
                                  AND "clientName" = $2
                                  AND "sessionId" = $3
                                  AND time = $4
                            )
                            UPDATE client_statistics_entity
                            SET shares = aggregated.total_shares,
                                "acceptedCount" = aggregated.total_accepted,
                                "rejectedCount" = aggregated.total_rejected,
                                "rejectedJobNotFoundCount" = aggregated.total_jnf_count,
                                "rejectedJobNotFoundDiff1" = aggregated.total_jnf_diff,
                                "rejectedDuplicateShareCount" = aggregated.total_dup_count,
                                "rejectedDuplicateShareDiff1" = aggregated.total_dup_diff,
                                "rejectedLowDifficultyShareCount" = aggregated.total_low_count,
                                "rejectedLowDifficultyShareDiff1" = aggregated.total_low_diff
                            FROM aggregated
                            WHERE client_statistics_entity.id = aggregated.keep_id
                        `, [dup.address, dup.clientName, dup.sessionId, dup.time]);

                        // Delete the other duplicates
                        await queryRunner.query(`
                            DELETE FROM client_statistics_entity
                            WHERE address = $1
                              AND "clientName" = $2
                              AND "sessionId" = $3
                              AND time = $4
                              AND id NOT IN (
                                  SELECT MIN(id)
                                  FROM client_statistics_entity
                                  WHERE address = $1
                                    AND "clientName" = $2
                                    AND "sessionId" = $3
                                    AND time = $4
                              )
                        `, [dup.address, dup.clientName, dup.sessionId, dup.time]);
                    }
                    console.log('[Migration] Deduplication complete');
                }

                // Add unique constraint
                await queryRunner.query(`
                    ALTER TABLE client_statistics_entity
                    ADD CONSTRAINT "UQ_client_statistics_composite"
                    UNIQUE (address, "clientName", "sessionId", time)
                `);
                console.log('[Migration] Successfully added UNIQUE constraint');

            } catch (error) {
                console.error('[Migration] Failed to add UNIQUE constraint:', error.message);
                console.error('[Migration] This is not critical - the application will create the constraint at runtime');
                // Don't throw - allow migration to continue
            }
        } else {
            // SQLite: Create unique index
            try {
                // Check if index already exists
                const existingIndex = await queryRunner.query(`
                    SELECT name FROM sqlite_master
                    WHERE type='index'
                    AND tbl_name='client_statistics_entity'
                    AND name='UQ_client_statistics_composite'
                `);

                if (existingIndex && existingIndex.length > 0) {
                    console.log('[Migration] UNIQUE index already exists, skipping');
                    return;
                }

                // Safely handle duplicates by accumulating shares
                console.log('[Migration] Checking for duplicates...');
                const duplicates = await queryRunner.query(`
                    SELECT address, clientName, sessionId, time, COUNT(*) as count
                    FROM client_statistics_entity
                    GROUP BY address, clientName, sessionId, time
                    HAVING COUNT(*) > 1
                `);

                if (duplicates && duplicates.length > 0) {
                    console.log(`[Migration] Found ${duplicates.length} duplicate groups, deduplicating...`);

                    // Create a temporary table with deduplicated data
                    await queryRunner.query(`
                        CREATE TEMPORARY TABLE temp_deduplicated AS
                        SELECT
                            MIN(id) as id,
                            address,
                            clientName,
                            sessionId,
                            time,
                            SUM(shares) as shares,
                            SUM(acceptedCount) as acceptedCount,
                            SUM(rejectedCount) as rejectedCount,
                            SUM(rejectedJobNotFoundCount) as rejectedJobNotFoundCount,
                            SUM(rejectedJobNotFoundDiff1) as rejectedJobNotFoundDiff1,
                            SUM(rejectedDuplicateShareCount) as rejectedDuplicateShareCount,
                            SUM(rejectedDuplicateShareDiff1) as rejectedDuplicateShareDiff1,
                            SUM(rejectedLowDifficultyShareCount) as rejectedLowDifficultyShareCount,
                            SUM(rejectedLowDifficultyShareDiff1) as rejectedLowDifficultyShareDiff1,
                            MIN(createdAt) as createdAt,
                            MAX(updatedAt) as updatedAt
                        FROM client_statistics_entity
                        GROUP BY address, clientName, sessionId, time
                    `);

                    // Delete all original records that have duplicates
                    for (const dup of duplicates) {
                        await queryRunner.query(`
                            DELETE FROM client_statistics_entity
                            WHERE address = ? AND clientName = ? AND sessionId = ? AND time = ?
                        `, [dup.address, dup.clientName, dup.sessionId, dup.time]);
                    }

                    // Insert deduplicated records back
                    await queryRunner.query(`
                        INSERT INTO client_statistics_entity
                            (id, address, clientName, sessionId, time, shares, acceptedCount, rejectedCount,
                             rejectedJobNotFoundCount, rejectedJobNotFoundDiff1, rejectedDuplicateShareCount,
                             rejectedDuplicateShareDiff1, rejectedLowDifficultyShareCount,
                             rejectedLowDifficultyShareDiff1, createdAt, updatedAt)
                        SELECT * FROM temp_deduplicated
                    `);

                    await queryRunner.query(`DROP TABLE temp_deduplicated`);
                    console.log('[Migration] Deduplication complete');
                }

                // Create unique index
                await queryRunner.query(`
                    CREATE UNIQUE INDEX "UQ_client_statistics_composite"
                    ON client_statistics_entity (address, clientName, sessionId, time)
                `);
                console.log('[Migration] Successfully created UNIQUE index');

            } catch (error) {
                console.error('[Migration] Failed to create UNIQUE index:', error.message);
                console.error('[Migration] This is not critical - the application will create the index at runtime');
                // Don't throw - allow migration to continue
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;

        if (dbType === 'postgres') {
            await queryRunner.query(`
                ALTER TABLE client_statistics_entity
                DROP CONSTRAINT "UQ_client_statistics_composite"
            `);
        } else {
            await queryRunner.query(`
                DROP INDEX "UQ_client_statistics_composite"
            `);
        }

        console.log('[Migration] Removed UNIQUE constraint from client_statistics_entity');
    }
}
