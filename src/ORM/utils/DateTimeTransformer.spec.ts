import { DateTimeTransformer } from './DateTimeTransformer';

describe('DateTimeTransformer', () => {
    const transformer = new DateTimeTransformer();

    it('passes through Date instances unchanged', () => {
        const date = new Date('2024-01-02T03:04:05.000Z');
        expect(transformer.from(date)).toBe(date);
        expect(transformer.to(date)).toBe(date);
    });

    it('parses ISO strings into Date objects', () => {
        const isoString = '2023-03-04T05:06:07.000Z';
        const result = transformer.from(isoString);
        expect(result).toBeInstanceOf(Date);
        expect(result?.toISOString()).toBe('2023-03-04T05:06:07.000Z');
    });

    it('parses legacy European locale strings (e.g. de-CH)', () => {
        const legacy = '16.12.2021, 22:12:32';
        const result = transformer.from(legacy);
        expect(result).toBeInstanceOf(Date);
        expect(result?.getFullYear()).toBe(2021);
        expect(result?.getMonth()).toBe(11); // zero indexed
        expect(result?.getDate()).toBe(16);
        expect(result?.getHours()).toBe(22);
        expect(result?.getMinutes()).toBe(12);
        expect(result?.getSeconds()).toBe(32);
    });

    it('parses legacy US locale strings with AM/PM', () => {
        const legacy = '12/16/2021, 10:12:32 PM';
        const result = transformer.from(legacy);
        expect(result).toBeInstanceOf(Date);
        expect(result?.getFullYear()).toBe(2021);
        expect(result?.getMonth()).toBe(11);
        expect(result?.getDate()).toBe(16);
        expect(result?.getHours()).toBe(22);
        expect(result?.getMinutes()).toBe(12);
        expect(result?.getSeconds()).toBe(32);
    });

    it('converts null and undefined safely', () => {
        expect(transformer.from(null)).toBeNull();
        expect(transformer.from(undefined)).toBeUndefined();
        expect(transformer.to(null)).toBeNull();
        expect(transformer.to(undefined)).toBeUndefined();
    });

    it('throws for unparseable strings', () => {
        expect(() => transformer.from('not a date')).toThrow('Invalid date value received: not a date');
    });
});
