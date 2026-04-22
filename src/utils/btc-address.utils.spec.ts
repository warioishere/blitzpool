import { normalizeBtcAddress } from './btc-address.utils';

describe('normalizeBtcAddress', () => {
    it('lowercases bech32 mainnet addresses', () => {
        expect(normalizeBtcAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe(
            'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        );
    });

    it('lowercases bech32m (taproot) mainnet addresses', () => {
        expect(normalizeBtcAddress('BC1PXW5... mixed Case ...'.trim())).toMatch(/^bc1p/);
    });

    it('lowercases testnet tb1', () => {
        expect(normalizeBtcAddress('TB1QSomething')).toBe('tb1qsomething');
    });

    it('lowercases regtest bcrt1', () => {
        expect(normalizeBtcAddress('BCRT1QSomething')).toBe('bcrt1qsomething');
    });

    it('leaves legacy P2PKH case-sensitive (base58)', () => {
        expect(normalizeBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))
            .toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    });

    it('leaves legacy P2SH case-sensitive', () => {
        expect(normalizeBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'))
            .toBe('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
    });

    it('trims whitespace', () => {
        expect(normalizeBtcAddress('  bc1qtest  ')).toBe('bc1qtest');
    });

    it('returns empty string for null/undefined/empty input', () => {
        expect(normalizeBtcAddress(null)).toBe('');
        expect(normalizeBtcAddress(undefined)).toBe('');
        expect(normalizeBtcAddress('')).toBe('');
    });
});
