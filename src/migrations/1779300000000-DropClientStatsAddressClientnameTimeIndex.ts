import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `IDX_cs_address_clientname_time` from `client_statistics_entity`.
 *
 * Index size: 439 MB (largest index on this table at the time of drop).
 * Usage: 591 scans across ~2 weeks of stats — about 42 reads per day.
 *
 * The (address, "clientName", time) ordering is fully covered as a prefix
 * by the existing UNIQUE constraint `UQ_client_statistics_composite`
 * (address, "clientName", "sessionId", time). Any (address)= or
 * (address, clientName)= query that previously used the dropped index
 * can still use the UNIQUE B-tree's leading columns.
 *
 * Heaviest queries against this table (per pg_stat_statements at the
 * time of drop) do NOT use this index:
 *   - The aggregation-maintenance query runs a Parallel Seq Scan
 *     (planner judges seq-scan cheaper given the row distribution).
 *   - Per-address charting uses `IDX_cs_address_time`.
 *   - Time-windowed pool aggregations use `IDX_cs_real_time_cov`.
 *   - Time-only DELETEs use `IDX_7d081302c6f984f26f81caa5cc`.
 *
 * Effect: ~440 MB freed, slightly faster INSERTs on the highest-throughput
 * table. If a specific query later needs (address, "clientName", time),
 * a targeted index can be reintroduced based on observation rather than
 * carried as speculative coverage.
 */
export class DropClientStatsAddressClientnameTimeIndex1779300000000
    implements MigrationInterface
{
    name = 'DropClientStatsAddressClientnameTimeIndex1779300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cs_address_clientname_time"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const dbType = queryRunner.connection.options.type;
        if (dbType !== 'postgres') {
            return;
        }

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cs_address_clientname_time"
            ON client_statistics_entity (address, "clientName", time)
        `);
    }
}
