import { maskEmail } from './email-mask.utils';

describe('maskEmail', () => {
    it('masks single-segment domains: alice@gmail.com → a***@g***.com', () => {
        expect(maskEmail('alice@gmail.com')).toBe('a***@g***.com');
    });

    it('masks custom domains so identity is not pinpointed: joe@joe.de → j***@j***.de', () => {
        expect(maskEmail('joe@joe.de')).toBe('j***@j***.de');
    });

    it('preserves multi-segment TLDs: carol@example.co.uk → c***@e***.co.uk', () => {
        expect(maskEmail('carol@example.co.uk')).toBe('c***@e***.co.uk');
    });

    it('returns "" for empty input', () => {
        expect(maskEmail('')).toBe('');
    });

    it('returns "***" for malformed shapes (no @ / leading @ / trailing @)', () => {
        expect(maskEmail('not-an-email')).toBe('***');
        expect(maskEmail('@oops.com')).toBe('***');
        expect(maskEmail('oops@')).toBe('***');
    });

    it('handles bare hostnames without TLD: dev@localhost → d***@***', () => {
        expect(maskEmail('dev@localhost')).toBe('d***@***');
    });

    it('keeps the format stable for unicode local-parts (first char is taken)', () => {
        // Defensive — non-ASCII local-parts are valid; we just take the first
        // code unit. The privacy property holds (one character of context only).
        expect(maskEmail('änna@example.com')).toBe('ä***@e***.com');
    });
});
