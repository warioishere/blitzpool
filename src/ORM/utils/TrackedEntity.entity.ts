import { Column, DeleteDateColumn } from 'typeorm';

import { epochMsTransformer } from './epoch-ms-transformer';

/**
 * Shared timestamp columns for all entities tracked by createdAt /
 * updatedAt / deletedAt. After the 2026-05 bigint cleanup the underlying
 * storage is `BIGINT` (epoch ms) — TypeORM hydration no longer allocates
 * a `Date` per column per row.
 *
 * `@DeleteDateColumn` is retained (over plain `@Column`) so TypeORM's
 * automatic `WHERE deletedAt IS NULL` filter on non-`withDeleted` queries
 * keeps working — that filter is column-metadata driven, not type-driven,
 * so it still applies on a `bigint` column.
 *
 * `softDelete()` API is NOT supported on this base — its default
 * `() => 'CURRENT_TIMESTAMP'` write does not match the bigint shape.
 * Use `repo.update({…}, { deletedAt: Date.now() })` explicitly instead.
 *
 * `createdAt` / `updatedAt` auto-fill via `TrackedEntityTimestampSubscriber`
 * (registered on the DataSource). It fires for `repo.save(...)` /
 * `repo.insert(...)` regardless of POJO-vs-entity-instance.
 * `createQueryBuilder().insert()` / `.update()` bypass it — those paths
 * must set the timestamps explicitly.
 */
export abstract class TrackedEntity {
    @DeleteDateColumn({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    public deletedAt?: number | null;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    public createdAt?: number;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    public updatedAt?: number;
}
