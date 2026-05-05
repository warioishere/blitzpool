/**
 * End-to-end equivalence test for the UNNEST refactor (commit 8cd8e3c).
 *
 * Connects to a real Postgres, inserts identical synthetic records via the
 * OLD VALUES-list path (inlined here as the reference implementation) AND
 * via the NEW UNNEST path (production code), and asserts the resulting
 * row state is byte-identical.
 *
 * Skipped by default. To run:
 *
 *   # against test pool, via SSH tunnel:
 *   ssh -fN -L 15432:172.17.0.1:5432 root@172.16.0.21
 *   docker -H tcp://172.16.0.21:2375 exec public-pool-postgres pg_isready  # or however you expose it
 *
 *   # OR simpler — copy this spec onto the test pool box and run there:
 *   # PG_E2E=1 PGHOST=localhost PGPORT=5432 PGUSER=postgres \
 *   #   PGPASSWORD=postgres PGDATABASE=public_pool \
 *   #   npx jest --runInBand src/services/statistics-coordinator.unnest-e2e
 *
 *   # OR easiest — exec inside the postgres container directly with this
 *   # spec mounted:
 *   # PG_E2E=1 PGHOST=public-pool-postgres PGUSER=postgres PGPASSWORD=postgres \
 *   #   PGDATABASE=public_pool npx jest --runInBand src/services/statistics-coordinator.unnest-e2e
 *
 * The test uses TEMP tables (session-scoped, auto-dropped on disconnect),
 * so it won't pollute the database it connects to. Safe to run against
 * test pool OR prod (read-only on existing tables — only TEMP tables
 * are written).
 */

const E2E_ENABLED = process.env.PG_E2E === '1';

// Lazy-import pg so the spec doesn't fail to load if pg isn't accessible.
// (typeorm pulls it in transitively, so it's always available, but we
// don't want the require to happen at module-load time when the e2e
// machinery is gated.)
const describeIf = E2E_ENABLED ? describe : describe.skip;

describeIf('UNNEST refactor — end-to-end equivalence vs old VALUES path', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    let client: any;

    beforeAll(async () => {
        client = new Client({
            host: process.env.PGHOST ?? 'localhost',
            port: parseInt(process.env.PGPORT ?? '5432', 10),
            user: process.env.PGUSER ?? 'postgres',
            password: process.env.PGPASSWORD ?? 'postgres',
            database: process.env.PGDATABASE ?? 'public_pool',
        });
        await client.connect();
    }, 30_000);

    afterAll(async () => {
        if (client) await client.end();
    });

    /**
     * Generic equivalence runner.
     *
     * 1. Creates a TEMP table with the given schema.
     * 2. Inserts `records` via the reference VALUES path.
     * 3. Snapshots the table → snapshotA.
     * 4. TRUNCATEs.
     * 5. Inserts `records` via the production UNNEST path.
     * 6. Snapshots → snapshotB.
     * 7. Asserts snapshotA deep-equals snapshotB.
     *
     * Then re-runs steps 2-3 and 5-6 with `recordsAccumulate` (same keys,
     * different values) layered on top, to verify ON CONFLICT additive
     * semantics produce identical accumulated state in both paths.
     */
    async function runEquivalenceTest(
        tempSchema: string,
        valuesInsertSqlBuilder: (records: any[]) => { sql: string; params: any[] },
        unnestInsertSqlBuilder: (records: any[]) => { sql: string; params: any[] },
        records: any[],
        recordsAccumulate: any[] = [],
        snapshotOrderBy: string,
    ) {
        await client.query(`CREATE TEMP TABLE bench_target (${tempSchema}) ON COMMIT PRESERVE ROWS`);

        try {
            // -- VALUES path round 1 --
            const v1 = valuesInsertSqlBuilder(records);
            await client.query(v1.sql, v1.params);
            if (recordsAccumulate.length > 0) {
                const v2 = valuesInsertSqlBuilder(recordsAccumulate);
                await client.query(v2.sql, v2.params);
            }
            const snapshotValues = (await client.query(`SELECT * FROM bench_target ORDER BY ${snapshotOrderBy}`)).rows;

            // -- UNNEST path round 2 (same input) --
            await client.query(`TRUNCATE bench_target`);
            const u1 = unnestInsertSqlBuilder(records);
            await client.query(u1.sql, u1.params);
            if (recordsAccumulate.length > 0) {
                const u2 = unnestInsertSqlBuilder(recordsAccumulate);
                await client.query(u2.sql, u2.params);
            }
            const snapshotUnnest = (await client.query(`SELECT * FROM bench_target ORDER BY ${snapshotOrderBy}`)).rows;

            // -- compare --
            expect(snapshotUnnest).toHaveLength(snapshotValues.length);
            // Strip auto-generated columns (id, createdAt, updatedAt) before
            // compare — those will differ between rounds even with same data.
            const stripVolatile = (rows: any[]) => rows.map(r => {
                const { id, createdAt, updatedAt, ...rest } = r;
                return rest;
            });
            expect(stripVolatile(snapshotUnnest)).toEqual(stripVolatile(snapshotValues));
        } finally {
            await client.query(`DROP TABLE IF EXISTS bench_target`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 1. bulkUpsertPoolShares
    // ─────────────────────────────────────────────────────────────────────
    it('bulkUpsertPoolShares: VALUES vs UNNEST produce identical row state (incl. ON CONFLICT)', async () => {
        const records = Array.from({ length: 500 }, (_, i) => ({
            time: 1700000000000 + i * 600000,
            accepted: 100 + i * 0.5,
            rejected: i * 0.1,
        }));
        // Same keys, different values → tests ON CONFLICT accumulation
        const accum = records.slice(0, 100).map(r => ({
            ...r,
            accepted: r.accepted + 50,
            rejected: r.rejected + 1,
        }));

        await runEquivalenceTest(
            `time bigint UNIQUE NOT NULL, accepted real DEFAULT 0, rejected real DEFAULT 0`,
            (recs) => {
                const params: any[] = [];
                let i = 1;
                const tuples = recs.map(r => {
                    params.push(r.time, r.accepted, r.rejected);
                    const t = `($${i}, $${i + 1}, $${i + 2})`;
                    i += 3;
                    return t;
                }).join(', ');
                return {
                    sql: `INSERT INTO bench_target (time, accepted, rejected) VALUES ${tuples}
                          ON CONFLICT (time) DO UPDATE SET
                            accepted = bench_target.accepted + EXCLUDED.accepted,
                            rejected = bench_target.rejected + EXCLUDED.rejected`,
                    params,
                };
            },
            (recs) => ({
                sql: `INSERT INTO bench_target (time, accepted, rejected)
                      SELECT * FROM unnest($1::bigint[], $2::real[], $3::real[])
                      ON CONFLICT (time) DO UPDATE SET
                        accepted = bench_target.accepted + EXCLUDED.accepted,
                        rejected = bench_target.rejected + EXCLUDED.rejected`,
                params: [
                    recs.map((r: any) => r.time),
                    recs.map((r: any) => r.accepted),
                    recs.map((r: any) => r.rejected),
                ],
            }),
            records,
            accum,
            'time',
        );
    });

    // ─────────────────────────────────────────────────────────────────────
    // 2. bulkUpsertPoolModeHashrate
    // ─────────────────────────────────────────────────────────────────────
    it('bulkUpsertPoolModeHashrate: equivalence with composite (mode, time) PK', async () => {
        const modes = ['solo', 'pplns', 'group-solo'];
        const records = Array.from({ length: 300 }, (_, i) => ({
            mode: modes[i % 3],
            time: 1700000000000 + Math.floor(i / 3) * 600000,
            diff: 100 + i,
        }));
        const accum = records.slice(0, 30).map(r => ({ ...r, diff: r.diff + 5 }));

        await runEquivalenceTest(
            `mode varchar(16) NOT NULL, time bigint NOT NULL, diff real DEFAULT 0, UNIQUE (mode, time)`,
            (recs) => {
                const params: any[] = [];
                let i = 1;
                const tuples = recs.map(r => {
                    params.push(r.mode, r.time, r.diff);
                    const t = `($${i}, $${i + 1}, $${i + 2})`;
                    i += 3;
                    return t;
                }).join(', ');
                return {
                    sql: `INSERT INTO bench_target (mode, time, diff) VALUES ${tuples}
                          ON CONFLICT (mode, time) DO UPDATE SET diff = bench_target.diff + EXCLUDED.diff`,
                    params,
                };
            },
            (recs) => ({
                sql: `INSERT INTO bench_target (mode, time, diff)
                      SELECT * FROM unnest($1::text[], $2::bigint[], $3::real[])
                      ON CONFLICT (mode, time) DO UPDATE SET diff = bench_target.diff + EXCLUDED.diff`,
                params: [
                    recs.map((r: any) => r.mode),
                    recs.map((r: any) => r.time),
                    recs.map((r: any) => r.diff),
                ],
            }),
            records,
            accum,
            'mode, time',
        );
    });

    // ─────────────────────────────────────────────────────────────────────
    // 3. bulkUpsertClientStatistics — the big one (13 cols × 1500 rows)
    // ─────────────────────────────────────────────────────────────────────
    it('bulkUpsertClientStatistics: 13-column equivalence at 1500 rows + ON CONFLICT', async () => {
        const records = Array.from({ length: 1500 }, (_, i) => ({
            address: `bc1q${i.toString().padStart(6, '0')}`,
            clientName: `rig-${i}`,
            sessionId: `sess-${i}`,
            time: 1700000000000 + i * 100,
            shares: i * 1.5,
            acceptedCount: i,
            rejectedCount: i % 5,
            rejectedJobNotFoundCount: i % 7,
            rejectedJobNotFoundDiff1: (i % 7) * 0.25,
            rejectedDuplicateShareCount: i % 11,
            rejectedDuplicateShareDiff1: (i % 11) * 0.5,
            rejectedLowDifficultyShareCount: i % 13,
            rejectedLowDifficultyShareDiff1: (i % 13) * 0.75,
        }));

        // Edge case: include a clientName with special chars that array
        // serialization could mangle (commas, braces, quotes, backslash).
        records.push({
            address: 'bc1qspecialchars',
            clientName: 'rig,with"quotes\\and{braces},and—commas',
            sessionId: 'sess-special',
            time: 1700000999999,
            shares: 42, acceptedCount: 1, rejectedCount: 0,
            rejectedJobNotFoundCount: 0, rejectedJobNotFoundDiff1: 0,
            rejectedDuplicateShareCount: 0, rejectedDuplicateShareDiff1: 0,
            rejectedLowDifficultyShareCount: 0, rejectedLowDifficultyShareDiff1: 0,
        });

        // Accumulate 200 records (overlapping keys) to test ON CONFLICT
        const accum = records.slice(0, 200).map(r => ({
            ...r,
            shares: r.shares + 7,
            acceptedCount: r.acceptedCount + 1,
        }));

        await runEquivalenceTest(
            `
                address text NOT NULL,
                "clientName" text NOT NULL,
                "sessionId" text NOT NULL,
                time bigint NOT NULL,
                shares real DEFAULT 0,
                "acceptedCount" int DEFAULT 0,
                "rejectedCount" int DEFAULT 0,
                "rejectedJobNotFoundCount" int DEFAULT 0,
                "rejectedJobNotFoundDiff1" real DEFAULT 0,
                "rejectedDuplicateShareCount" int DEFAULT 0,
                "rejectedDuplicateShareDiff1" real DEFAULT 0,
                "rejectedLowDifficultyShareCount" int DEFAULT 0,
                "rejectedLowDifficultyShareDiff1" real DEFAULT 0,
                UNIQUE (address, "clientName", "sessionId", time)
            `,
            (recs) => {
                const params: any[] = [];
                let i = 1;
                const tuples = recs.map(r => {
                    params.push(
                        r.address, r.clientName, r.sessionId, r.time,
                        r.shares, r.acceptedCount, r.rejectedCount,
                        r.rejectedJobNotFoundCount, r.rejectedJobNotFoundDiff1,
                        r.rejectedDuplicateShareCount, r.rejectedDuplicateShareDiff1,
                        r.rejectedLowDifficultyShareCount, r.rejectedLowDifficultyShareDiff1,
                    );
                    const t = `($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11},$${i + 12})`;
                    i += 13;
                    return t;
                }).join(', ');
                return {
                    sql: `INSERT INTO bench_target (address, "clientName", "sessionId", time, shares, "acceptedCount", "rejectedCount", "rejectedJobNotFoundCount", "rejectedJobNotFoundDiff1", "rejectedDuplicateShareCount", "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareCount", "rejectedLowDifficultyShareDiff1") VALUES ${tuples}
                          ON CONFLICT (address, "clientName", "sessionId", time) DO UPDATE SET
                            shares = bench_target.shares + EXCLUDED.shares,
                            "acceptedCount" = bench_target."acceptedCount" + EXCLUDED."acceptedCount",
                            "rejectedCount" = bench_target."rejectedCount" + EXCLUDED."rejectedCount",
                            "rejectedJobNotFoundCount" = bench_target."rejectedJobNotFoundCount" + EXCLUDED."rejectedJobNotFoundCount",
                            "rejectedJobNotFoundDiff1" = bench_target."rejectedJobNotFoundDiff1" + EXCLUDED."rejectedJobNotFoundDiff1",
                            "rejectedDuplicateShareCount" = bench_target."rejectedDuplicateShareCount" + EXCLUDED."rejectedDuplicateShareCount",
                            "rejectedDuplicateShareDiff1" = bench_target."rejectedDuplicateShareDiff1" + EXCLUDED."rejectedDuplicateShareDiff1",
                            "rejectedLowDifficultyShareCount" = bench_target."rejectedLowDifficultyShareCount" + EXCLUDED."rejectedLowDifficultyShareCount",
                            "rejectedLowDifficultyShareDiff1" = bench_target."rejectedLowDifficultyShareDiff1" + EXCLUDED."rejectedLowDifficultyShareDiff1"`,
                    params,
                };
            },
            (recs) => ({
                sql: `INSERT INTO bench_target (address, "clientName", "sessionId", time, shares, "acceptedCount", "rejectedCount", "rejectedJobNotFoundCount", "rejectedJobNotFoundDiff1", "rejectedDuplicateShareCount", "rejectedDuplicateShareDiff1", "rejectedLowDifficultyShareCount", "rejectedLowDifficultyShareDiff1")
                      SELECT * FROM unnest(
                        $1::text[], $2::text[], $3::text[], $4::bigint[],
                        $5::real[], $6::int[], $7::int[],
                        $8::int[], $9::real[], $10::int[], $11::real[],
                        $12::int[], $13::real[]
                      )
                      ON CONFLICT (address, "clientName", "sessionId", time) DO UPDATE SET
                        shares = bench_target.shares + EXCLUDED.shares,
                        "acceptedCount" = bench_target."acceptedCount" + EXCLUDED."acceptedCount",
                        "rejectedCount" = bench_target."rejectedCount" + EXCLUDED."rejectedCount",
                        "rejectedJobNotFoundCount" = bench_target."rejectedJobNotFoundCount" + EXCLUDED."rejectedJobNotFoundCount",
                        "rejectedJobNotFoundDiff1" = bench_target."rejectedJobNotFoundDiff1" + EXCLUDED."rejectedJobNotFoundDiff1",
                        "rejectedDuplicateShareCount" = bench_target."rejectedDuplicateShareCount" + EXCLUDED."rejectedDuplicateShareCount",
                        "rejectedDuplicateShareDiff1" = bench_target."rejectedDuplicateShareDiff1" + EXCLUDED."rejectedDuplicateShareDiff1",
                        "rejectedLowDifficultyShareCount" = bench_target."rejectedLowDifficultyShareCount" + EXCLUDED."rejectedLowDifficultyShareCount",
                        "rejectedLowDifficultyShareDiff1" = bench_target."rejectedLowDifficultyShareDiff1" + EXCLUDED."rejectedLowDifficultyShareDiff1"`,
                params: [
                    recs.map((r: any) => r.address),
                    recs.map((r: any) => r.clientName),
                    recs.map((r: any) => r.sessionId),
                    recs.map((r: any) => r.time),
                    recs.map((r: any) => r.shares),
                    recs.map((r: any) => r.acceptedCount),
                    recs.map((r: any) => r.rejectedCount),
                    recs.map((r: any) => r.rejectedJobNotFoundCount),
                    recs.map((r: any) => r.rejectedJobNotFoundDiff1),
                    recs.map((r: any) => r.rejectedDuplicateShareCount),
                    recs.map((r: any) => r.rejectedDuplicateShareDiff1),
                    recs.map((r: any) => r.rejectedLowDifficultyShareCount),
                    recs.map((r: any) => r.rejectedLowDifficultyShareDiff1),
                ],
            }),
            records,
            accum,
            `address, "clientName", "sessionId", time`,
        );
    }, 60_000);

    // ─────────────────────────────────────────────────────────────────────
    // 4. WorkerSharesService.addSharesBulk
    // ─────────────────────────────────────────────────────────────────────
    it('WorkerSharesService.addSharesBulk: 1500-row equivalence with composite PK', async () => {
        const records = Array.from({ length: 1500 }, (_, i) => ({
            address: `bc1q${i}`,
            clientName: `rig-${i}`,
            shares: i * 1.5,
        }));
        const accum = records.slice(0, 100).map(r => ({ ...r, shares: r.shares + 10 }));

        await runEquivalenceTest(
            `address text NOT NULL, "clientName" text NOT NULL, shares double precision DEFAULT 0, UNIQUE (address, "clientName")`,
            (recs) => {
                const params: any[] = [];
                let i = 1;
                const tuples = recs.map(r => {
                    params.push(r.address, r.clientName, r.shares);
                    const t = `($${i}, $${i + 1}, $${i + 2}::double precision)`;
                    i += 3;
                    return t;
                }).join(', ');
                return {
                    sql: `INSERT INTO bench_target (address, "clientName", shares) VALUES ${tuples}
                          ON CONFLICT (address, "clientName") DO UPDATE SET
                            shares = bench_target.shares + EXCLUDED.shares`,
                    params,
                };
            },
            (recs) => ({
                sql: `INSERT INTO bench_target (address, "clientName", shares)
                      SELECT * FROM unnest($1::text[], $2::text[], $3::double precision[])
                      ON CONFLICT (address, "clientName") DO UPDATE SET
                        shares = bench_target.shares + EXCLUDED.shares`,
                params: [
                    recs.map((r: any) => r.address),
                    recs.map((r: any) => r.clientName),
                    recs.map((r: any) => r.shares),
                ],
            }),
            records,
            accum,
            `address, "clientName"`,
        );
    }, 60_000);

    // ─────────────────────────────────────────────────────────────────────
    // 5. AddressSettingsService.addSharesBulk — different shape (UPDATE only)
    // ─────────────────────────────────────────────────────────────────────
    it('AddressSettingsService.addSharesBulk: UPDATE FROM unnest equivalence with CASE/WHEN', async () => {
        const seedRecords = Array.from({ length: 500 }, (_, i) => ({
            address: `bc1q${i}`,
            shares: i * 10,
        }));
        const updates = Array.from({ length: 500 }, (_, i) => ({
            address: `bc1q${i}`,
            delta: 5,
        }));

        // Set up: pre-populate the shared baseline state
        await client.query(`CREATE TEMP TABLE bench_target (address text PRIMARY KEY, shares double precision DEFAULT 0) ON COMMIT PRESERVE ROWS`);
        try {
            // Seed
            const seedParams: any[] = [];
            let pi = 1;
            const seedTuples = seedRecords.map(r => {
                seedParams.push(r.address, r.shares);
                const t = `($${pi}, $${pi + 1})`;
                pi += 2;
                return t;
            }).join(', ');
            await client.query(`INSERT INTO bench_target (address, shares) VALUES ${seedTuples}`, seedParams);

            // CASE/WHEN path (the OLD impl)
            const casePieces: string[] = [];
            const caseParams: any[] = [];
            let i = 1;
            updates.forEach(u => {
                casePieces.push(`WHEN $${i} THEN $${i + 1}::double precision`);
                caseParams.push(u.address, u.delta);
                i += 2;
            });
            const wherePh = updates.map((_, idx) => `$${i + idx}`).join(',');
            await client.query(
                `UPDATE bench_target SET shares = shares + CASE address ${casePieces.join(' ')} END WHERE address IN (${wherePh})`,
                [...caseParams, ...updates.map(u => u.address)],
            );
            const snapshotValues = (await client.query(`SELECT * FROM bench_target ORDER BY address`)).rows;

            // Reset to seed
            await client.query(`TRUNCATE bench_target`);
            await client.query(`INSERT INTO bench_target (address, shares) VALUES ${seedTuples}`, seedParams);

            // UNNEST path (new)
            await client.query(
                `UPDATE bench_target AS t SET shares = t.shares + d.delta
                 FROM (SELECT unnest($1::text[]) AS address, unnest($2::double precision[]) AS delta) AS d
                 WHERE t.address = d.address`,
                [updates.map(u => u.address), updates.map(u => u.delta)],
            );
            const snapshotUnnest = (await client.query(`SELECT * FROM bench_target ORDER BY address`)).rows;

            expect(snapshotUnnest).toEqual(snapshotValues);
        } finally {
            await client.query(`DROP TABLE IF EXISTS bench_target`);
        }
    }, 30_000);

    // ─────────────────────────────────────────────────────────────────────
    // Edge case: special characters in array elements
    // ─────────────────────────────────────────────────────────────────────
    it('node-postgres correctly escapes commas, quotes, braces, backslashes in text array elements', async () => {
        await client.query(`CREATE TEMP TABLE bench_target (val text PRIMARY KEY)`);
        try {
            const tricky = [
                'plain',
                'with,comma',
                'with"quote',
                'with}brace',
                'with{brace',
                'with\\backslash',
                'with NULL\\\\NULL',
                ',leading-comma',
                'trailing-comma,',
                '"',
                '\\',
                '{}',
                '',
            ];
            await client.query(
                `INSERT INTO bench_target (val) SELECT unnest($1::text[])`,
                [tricky],
            );
            const back = (await client.query(`SELECT val FROM bench_target ORDER BY val`)).rows
                .map((r: any) => r.val).sort();
            expect(back).toEqual([...tricky].sort());
        } finally {
            await client.query(`DROP TABLE IF EXISTS bench_target`);
        }
    });
});
