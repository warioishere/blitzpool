import { EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from 'typeorm';

import { TrackedEntity } from './TrackedEntity.entity';

/**
 * Auto-fills `createdAt` / `updatedAt` on TrackedEntity-extending inserts
 * and bumps `updatedAt` on `repo.update(...)` / `repo.save(...)` paths.
 *
 * Replaces the auto-bump behaviour of the (since-removed) TypeORM
 * `@UpdateDateColumn` decorator. The bigint cleanup migrated those
 * decorated columns to plain `@Column({ type: 'bigint' })`, which
 * silently dropped the auto-bump — multiple callers (`updateBestDifficulty`
 * et al.) relied on it without setting `updatedAt` themselves. This
 * subscriber restores the original semantic.
 *
 * Does NOT fire on `createQueryBuilder().insert()` / `.update()` —
 * those code paths still must set the timestamps explicitly. Auditing
 * those: ripgrep `'\.update\([A-Z][a-zA-Z]+Entity\)'` and ensure each
 * `.set({...})` block includes `updatedAt: Date.now()` (or omits it
 * intentionally — e.g. `addShares` preserves the prior value).
 */
@EventSubscriber()
export class TrackedEntityTimestampSubscriber implements EntitySubscriberInterface<TrackedEntity> {

    listenTo() {
        return TrackedEntity;
    }

    beforeInsert(event: InsertEvent<TrackedEntity>): void {
        const entity = event.entity as any;
        if (!entity || typeof entity !== 'object') return;
        const now = Date.now();
        if (entity.createdAt == null) entity.createdAt = now;
        if (entity.updatedAt == null) entity.updatedAt = now;
    }

    beforeUpdate(event: UpdateEvent<TrackedEntity>): void {
        const entity = event.entity as any;
        if (!entity || typeof entity !== 'object') return;

        // Two call shapes feed this hook, with different ways of telling
        // whether the caller explicitly authored a value for updatedAt:
        //
        //   • repo.update(criteria, partial)
        //       → event.databaseEntity is undefined (no load happened)
        //       → entity === partial
        //       → caller "wrote" updatedAt iff it's present on the partial.
        //
        //   • repo.save(entityInstance)
        //       → event.databaseEntity is the loaded row
        //       → entity === the in-memory instance the caller mutated
        //       → caller "wrote" updatedAt iff its value differs from
        //         databaseEntity.updatedAt. If they're equal it's just
        //         the loaded leftover.
        //
        // When the caller didn't author the field, we bump it to match the
        // pre-bigint @UpdateDateColumn semantic.
        const databaseEntity = event.databaseEntity as any;
        let callerWroteUpdatedAt: boolean;
        if (entity.updatedAt == null) {
            // Absent from the caller's payload — they didn't author it.
            callerWroteUpdatedAt = false;
        } else if (databaseEntity != null && entity.updatedAt === databaseEntity.updatedAt) {
            // Value matches the row we just loaded — it's leftover from a
            // findOne/load, not a deliberate write by the caller.
            callerWroteUpdatedAt = false;
        } else {
            callerWroteUpdatedAt = true;
        }

        if (!callerWroteUpdatedAt) {
            entity.updatedAt = Date.now();
        }
    }
}
