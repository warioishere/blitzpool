import { Entity, EntityOptions } from 'typeorm';

/**
 * Returns a TypeORM `Entity` decorator that adds `withoutRowid` when
 * running against SQLite. For other databases the option is omitted.
 */
export function DbAwareEntity(options: EntityOptions = {}): ClassDecorator {
    if (!process.env.DB_TYPE || process.env.DB_TYPE === 'sqlite') {
        return Entity({ ...options, withoutRowid: true });
    }
    const { withoutRowid, ...rest } = options;
    return Entity(rest);
}
