import {
    SwapBuffer,
    NumberDeltaBuffer,
    RecordDeltaBuffer,
    NestedDeltaBuffer,
} from './buffers';

describe('SwapBuffer', () => {
    it('latest write wins per key', () => {
        const buf = new SwapBuffer<string, number>();
        buf.set('a', 1);
        buf.set('a', 2);
        expect(buf.size).toBe(1);
        expect(buf.get('a')).toBe(2);
    });

    it('drain returns the snapshot and replaces the buffer', () => {
        const buf = new SwapBuffer<string, number>();
        buf.set('a', 1);
        const snap = buf.drain();
        expect(snap.get('a')).toBe(1);
        expect(buf.size).toBe(0);
    });

    it('rebuffer default policy: live newer wins over re-buffered older', () => {
        const buf = new SwapBuffer<string, number>();
        buf.set('a', 1);
        const snap = buf.drain();
        buf.set('a', 999);
        buf.rebuffer(snap);
        expect(buf.get('a')).toBe(999);
    });

    it('rebuffer with max-merge keeps the larger value (difficulty buffer pattern)', () => {
        const buf = new SwapBuffer<string, number>();
        buf.set('a', 10);
        const snap = buf.drain();
        buf.set('a', 5);
        buf.rebuffer(snap, (incoming, existing) =>
            existing === undefined ? incoming : Math.max(existing, incoming),
        );
        expect(buf.get('a')).toBe(10);
    });
});

describe('NumberDeltaBuffer', () => {
    it('add accumulates by key', () => {
        const buf = new NumberDeltaBuffer<string>();
        buf.add('a', 5);
        buf.add('a', 3);
        buf.add('b', 1);
        expect(buf.size).toBe(2);
    });

    it('drain is non-clearing — subsequent reads see the same values', () => {
        const buf = new NumberDeltaBuffer<string>();
        buf.add('a', 5);
        const snap1 = buf.drain();
        const snap2 = buf.drain();
        expect(snap1.get('a')).toBe(5);
        expect(snap2.get('a')).toBe(5);
    });

    it('confirm subtracts the flushed amount; residuals from concurrent adds remain', () => {
        const buf = new NumberDeltaBuffer<string>();
        buf.add('a', 10);
        const snap = buf.drain();
        buf.add('a', 3); // concurrent add during the flush
        buf.confirm(snap);
        // 10 + 3 - 10 = 3 left
        const after = buf.drain();
        expect(after.get('a')).toBe(3);
    });

    it('confirm removes the key when the residual is ≤ 0', () => {
        const buf = new NumberDeltaBuffer<string>();
        buf.add('a', 10);
        const snap = buf.drain();
        buf.confirm(snap);
        expect(buf.size).toBe(0);
    });

    it('deleteWhere drops keys by predicate (account-deletion path)', () => {
        const buf = new NumberDeltaBuffer<string>();
        buf.add('addr1 worker', 5);
        buf.add('addr1 worker2', 3);
        buf.add('addr2 worker', 1);
        buf.deleteWhere(k => k.startsWith('addr1 '));
        expect(buf.size).toBe(1);
    });
});

describe('RecordDeltaBuffer', () => {
    type F = 'shares' | 'count';
    const FIELDS: readonly F[] = ['shares', 'count'];

    it('addField + addRecord both accumulate', () => {
        const buf = new RecordDeltaBuffer<string, F>(FIELDS);
        buf.addField('a', 'shares', 5);
        buf.addRecord('a', { count: 1, shares: 3 });
        const snap = buf.drain();
        expect(snap.get('a')).toEqual({ shares: 8, count: 1 });
    });

    it('drain skips buckets with all-zero fields', () => {
        const buf = new RecordDeltaBuffer<string, F>(FIELDS);
        buf.addField('a', 'shares', 5);
        const snap1 = buf.drain();
        buf.confirm(snap1);
        // Bucket should be gone after confirm; nothing to drain.
        expect(buf.drain().size).toBe(0);
    });

    it('confirm subtracts per-field and drops bucket when all fields ≤ 0', () => {
        const buf = new RecordDeltaBuffer<string, F>(FIELDS);
        buf.addRecord('a', { shares: 10, count: 5 });
        const snap = buf.drain();
        // Concurrent add during flush
        buf.addRecord('a', { shares: 2, count: 1 });
        buf.confirm(snap);
        const after = buf.drain();
        expect(after.get('a')).toEqual({ shares: 2, count: 1 });
    });

    it('deleteWhere drops keys by predicate', () => {
        const buf = new RecordDeltaBuffer<string, F>(FIELDS);
        buf.addField('addr1|x', 'count', 1);
        buf.addField('addr2|x', 'count', 1);
        buf.deleteWhere(k => k.startsWith('addr1|'));
        expect(buf.size).toBe(1);
    });
});

describe('NestedDeltaBuffer', () => {
    it('nested add by (outer, inner)', () => {
        const buf = new NestedDeltaBuffer<number, string>();
        buf.add(100, 'reason-a', 5);
        buf.add(100, 'reason-b', 3);
        buf.add(200, 'reason-a', 1);
        expect(buf.size).toBe(2);
    });

    it('drain copies; confirm subtracts and prunes empty inner maps', () => {
        const buf = new NestedDeltaBuffer<number, string>();
        buf.add(100, 'r', 5);
        const snap = buf.drain();
        buf.add(100, 'r', 2);
        buf.confirm(snap);
        const after = buf.drain();
        expect(after.get(100)?.get('r')).toBe(2);
    });

    it('outer key is dropped once inner map is empty after confirm', () => {
        const buf = new NestedDeltaBuffer<number, string>();
        buf.add(100, 'r', 5);
        const snap = buf.drain();
        buf.confirm(snap);
        expect(buf.size).toBe(0);
    });
});
