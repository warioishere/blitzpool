/**
 * Buffer family for the "hot-path writes, periodic bulk-flush" pattern that
 * every accumulator service across PPLNS / Group-Solo / statistics uses.
 *
 * All buffers share the same conceptual API:
 *
 *   buf.add* / buf.set   — hot path, synchronous, non-throwing
 *   buf.size             — count of unflushed keys
 *   buf.drain()          — start a flush; returns a snapshot
 *   buf.confirm(snap)    — flush succeeded; subtract / clear the snapshot
 *   buf.rebuffer(snap)   — flush failed; merge the snapshot back in
 *
 * Two semantic models, depending on the data shape:
 *
 *   • SwapBuffer  — latest-wins-by-key. drain() clears the buffer.
 *                   rebuffer merges back any keys that didn't get a newer
 *                   write during the flush. Used for heartbeats / touches.
 *
 *   • DeltaBuffer — additive numeric deltas. drain() copies a non-clearing
 *                   snapshot. confirm() subtracts the flushed amounts so
 *                   concurrent writes during the flush are preserved.
 *                   Specialised into Number / Record-of-fields / Nested
 *                   for the three observed shapes.
 */

// ── SwapBuffer ──────────────────────────────────────────────────────────────

export class SwapBuffer<K, V> {
    private buffer = new Map<K, V>();

    set(key: K, value: V): void {
        this.buffer.set(key, value);
    }

    get size(): number {
        return this.buffer.size;
    }

    /** Snapshot + replace with fresh empty buffer. New writes go to the new one. */
    drain(): Map<K, V> {
        const s = this.buffer;
        this.buffer = new Map();
        return s;
    }

    /**
     * Merge a previously-drained snapshot back into the live buffer after a
     * flush failure. Default policy: incoming wins only if the live buffer
     * has no newer entry for that key.
     */
    rebuffer(
        snapshot: Map<K, V>,
        merge: (incoming: V, existing: V | undefined) => V = (incoming, existing) => existing ?? incoming,
    ): void {
        for (const [k, v] of snapshot) {
            const existing = this.buffer.get(k);
            this.buffer.set(k, merge(v, existing));
        }
    }

    entries(): IterableIterator<[K, V]> {
        return this.buffer.entries();
    }

    clear(): void {
        this.buffer.clear();
    }

    delete(key: K): boolean {
        return this.buffer.delete(key);
    }

    has(key: K): boolean {
        return this.buffer.has(key);
    }

    get(key: K): V | undefined {
        return this.buffer.get(key);
    }
}

// ── NumberDeltaBuffer ───────────────────────────────────────────────────────

/**
 * Map<K, number> with additive semantics. Used for lifetime share totals
 * (per-address, per-worker).
 */
export class NumberDeltaBuffer<K> {
    private map = new Map<K, number>();

    add(key: K, delta: number): void {
        if (delta === 0) return;
        const prev = this.map.get(key) ?? 0;
        this.map.set(key, prev + delta);
    }

    get size(): number {
        return this.map.size;
    }

    /** Non-clearing snapshot for flush. Only positive entries included. */
    drain(): Map<K, number> {
        const snap = new Map<K, number>();
        for (const [k, v] of this.map) {
            if (v > 0) snap.set(k, v);
        }
        return snap;
    }

    /** Subtract a previously-drained snapshot. Concurrent adds remain. */
    confirm(snapshot: Map<K, number>): void {
        for (const [k, flushed] of snapshot) {
            const current = this.map.get(k) ?? 0;
            const residual = current - flushed;
            if (residual <= 0) {
                this.map.delete(k);
            } else {
                this.map.set(k, residual);
            }
        }
    }

    /** No-op for DeltaBuffer family — failed flushes leave state untouched. */
    rebuffer(_snapshot: Map<K, number>): void {
        // intentional no-op: drain() never cleared the buffer, so the
        // unflushed deltas are still there for the next drain.
    }

    delete(key: K): void {
        this.map.delete(key);
    }

    /** Filter-delete (used on per-address account deletion). */
    deleteWhere(predicate: (key: K) => boolean): void {
        for (const k of this.map.keys()) {
            if (predicate(k)) this.map.delete(k);
        }
    }

    entries(): IterableIterator<[K, number]> {
        return this.map.entries();
    }

    keys(): IterableIterator<K> {
        return this.map.keys();
    }

    get(key: K): number | undefined {
        return this.map.get(key);
    }
}

// ── RecordDeltaBuffer ───────────────────────────────────────────────────────

/**
 * Map<K, Record<F, number>> with additive semantics across N named fields.
 * One bucket per key carrying N counters; drain copies, confirm subtracts.
 * Used for pool-share (accepted/rejected), client-stats (10 fields),
 * client-rejected (count/shares).
 */
export class RecordDeltaBuffer<K, F extends string> {
    private map = new Map<K, Record<F, number>>();
    private readonly fields: readonly F[];

    constructor(fields: readonly F[]) {
        this.fields = fields;
    }

    /** Create a zero-initialised bucket. */
    private emptyBucket(): Record<F, number> {
        const b = {} as Record<F, number>;
        for (const f of this.fields) b[f] = 0;
        return b;
    }

    /** Add a single field's delta. */
    addField(key: K, field: F, delta: number): void {
        if (delta === 0) return;
        let r = this.map.get(key);
        if (!r) {
            r = this.emptyBucket();
            this.map.set(key, r);
        }
        r[field] += delta;
    }

    /** Add multiple fields at once. */
    addRecord(key: K, partial: Partial<Record<F, number>>): void {
        let r = this.map.get(key);
        let touched = false;
        for (const f of this.fields) {
            const v = partial[f];
            if (v == null || v === 0) continue;
            if (!r) {
                r = this.emptyBucket();
                this.map.set(key, r);
            }
            r[f] += v;
            touched = true;
        }
        // touched is for clarity; nothing extra to do.
        void touched;
    }

    get size(): number {
        return this.map.size;
    }

    /** Non-clearing snapshot for flush. Skips buckets with all-zero fields. */
    drain(): Map<K, Record<F, number>> {
        const snap = new Map<K, Record<F, number>>();
        for (const [k, r] of this.map) {
            let anyNonZero = false;
            for (const f of this.fields) {
                if (r[f] !== 0) { anyNonZero = true; break; }
            }
            if (anyNonZero) snap.set(k, { ...r });
        }
        return snap;
    }

    /** Subtract a previously-drained snapshot. Removes the bucket when all fields ≤ 0. */
    confirm(snapshot: Map<K, Record<F, number>>): void {
        for (const [k, snapR] of snapshot) {
            const current = this.map.get(k);
            if (!current) continue;
            let allLeZero = true;
            for (const f of this.fields) {
                current[f] -= snapR[f] ?? 0;
                if (current[f] > 0) allLeZero = false;
            }
            if (allLeZero) this.map.delete(k);
        }
    }

    rebuffer(_snapshot: Map<K, Record<F, number>>): void {
        // No-op for the delta semantics; the buffer wasn't cleared on drain.
    }

    delete(key: K): void {
        this.map.delete(key);
    }

    deleteWhere(predicate: (key: K) => boolean): void {
        for (const k of this.map.keys()) {
            if (predicate(k)) this.map.delete(k);
        }
    }

    values(): IterableIterator<Record<F, number>> {
        return this.map.values();
    }

    entries(): IterableIterator<[K, Record<F, number>]> {
        return this.map.entries();
    }

    get(key: K): Record<F, number> | undefined {
        return this.map.get(key);
    }
}

// ── NestedDeltaBuffer ───────────────────────────────────────────────────────

/**
 * Map<OuterK, Map<InnerK, number>> nested additive deltas. Used for
 * pool-mode-hashrate (slot → mode → diff) and pool-rejected (slot →
 * reason → count).
 */
export class NestedDeltaBuffer<OuterK, InnerK> {
    private map = new Map<OuterK, Map<InnerK, number>>();

    add(outer: OuterK, inner: InnerK, delta: number): void {
        if (delta === 0) return;
        let m = this.map.get(outer);
        if (!m) {
            m = new Map();
            this.map.set(outer, m);
        }
        const prev = m.get(inner) ?? 0;
        m.set(inner, prev + delta);
    }

    get size(): number {
        return this.map.size;
    }

    /** Deep snapshot — copy of each inner map. */
    drain(): Map<OuterK, Map<InnerK, number>> {
        const snap = new Map<OuterK, Map<InnerK, number>>();
        for (const [outer, inner] of this.map) {
            const copy = new Map<InnerK, number>();
            for (const [k, v] of inner) {
                if (v > 0) copy.set(k, v);
            }
            if (copy.size > 0) snap.set(outer, copy);
        }
        return snap;
    }

    /** Subtract a previously-drained snapshot. Drops outer keys whose inner map becomes empty. */
    confirm(snapshot: Map<OuterK, Map<InnerK, number>>): void {
        for (const [outer, innerSnap] of snapshot) {
            const current = this.map.get(outer);
            if (!current) continue;
            for (const [k, flushed] of innerSnap) {
                const have = current.get(k) ?? 0;
                const residual = have - flushed;
                if (residual <= 0) {
                    current.delete(k);
                } else {
                    current.set(k, residual);
                }
            }
            if (current.size === 0) {
                this.map.delete(outer);
            }
        }
    }

    rebuffer(_snapshot: Map<OuterK, Map<InnerK, number>>): void {
        // No-op for the delta semantics.
    }

    keys(): IterableIterator<OuterK> {
        return this.map.keys();
    }
}
