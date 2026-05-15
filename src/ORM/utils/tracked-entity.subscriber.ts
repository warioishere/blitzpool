import { EntitySubscriberInterface, EventSubscriber, InsertEvent } from 'typeorm';

import { TrackedEntity } from './TrackedEntity.entity';

/**
 * Auto-fills `createdAt` / `updatedAt` on TrackedEntity-extending inserts
 * + bumps `updatedAt` on entity-instance updates. Unlike `@BeforeInsert`
 * decorators on the abstract class, this subscriber fires for every
 * `repo.save(...)` / `repo.insert(...)` call regardless of whether the
 * caller passed an entity-class instance or a plain partial object —
 * TypeORM constructs the event from the input either way.
 *
 * Does NOT fire on `createQueryBuilder().insert()` / `.update()` —
 * those code paths must set the timestamps themselves.
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

    // beforeUpdate intentionally omitted: TypeORM's UpdateEvent.entity can be
    // the literal SET-values object on createQueryBuilder().update() flows, and
    // there's no clean way to distinguish "caller set updatedAt to a specific
    // value" from "caller didn't set updatedAt, please auto-bump". Callers that
    // want updatedAt to bump set it explicitly (`entity.updatedAt = Date.now()`
    // before `repo.save(entity)`, or include it in the `.set({...})` clause).
}
