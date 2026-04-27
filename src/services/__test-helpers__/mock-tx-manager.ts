/**
 * Test helper: wires a fake TypeORM `EntityManager` onto a set of mock
 * repos so the services' `historyRepo.manager.transaction(cb)` calls work
 * in unit tests (which don't have a real DataSource).
 *
 * The returned object behaves like:
 *   {
 *     transaction(cb)            → cb(em)            // no real TX, just runs cb
 *     getRepository(EntityClass) → the registered mock repo for that entity
 *   }
 *
 * Each passed-in repo gets `.manager` set to this fake EM so both
 * `repo.manager.transaction(...)` and `em.getRepository(Entity)` resolve
 * to the same place.
 */
export function attachMockTxManager(
    entries: Array<[entityClass: any, mockRepo: any]>,
): any {
    const registry = new Map<any, any>(entries);
    const em: any = {
        transaction: async (cb: (em: any) => Promise<any>) => cb(em),
        getRepository: (cls: any) => {
            const repo = registry.get(cls);
            if (!repo) {
                throw new Error(
                    `[mock-tx-manager] No mock repo registered for entity class ${cls?.name ?? cls}. ` +
                    `Register it via attachMockTxManager([[EntityClass, mockRepo], ...]).`,
                );
            }
            return repo;
        },
    };
    for (const [, repo] of entries) {
        repo.manager = em;
    }
    return em;
}
