/**
 * BIP141 Witness Stripping Tests
 *
 * Test vectors extracted from:
 * stratum/sv2/channels-sv2/src/lib/bip141.rs
 *
 * These tests verify 100% compatibility with the SV2 reference implementation.
 */

import { stripBip141, hasWitnessBytes } from './bip141.utils';

describe('BIP141 Witness Stripping', () => {
  describe('hasWitnessBytes()', () => {
    it('should detect witness marker and flag', () => {
      const prefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x00,                   // MARKER
        0x01,                   // FLAG
        0x01,                   // input count
      ]);

      expect(hasWitnessBytes(prefix)).toBe(true);
    });

    it('should return false for non-witness (already stripped)', () => {
      const prefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x01,                   // input count (NOT marker)
        0x00,                   // (would be flag position)
      ]);

      expect(hasWitnessBytes(prefix)).toBe(false);
    });

    it('should return false for flag = 0x00', () => {
      const prefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x00,                   // MARKER
        0x00,                   // FLAG = 0x00 (invalid)
      ]);

      expect(hasWitnessBytes(prefix)).toBe(false);
    });

    it('should return false for short buffer', () => {
      const prefix = Buffer.from([0x02, 0x00, 0x00]); // too short
      expect(hasWitnessBytes(prefix)).toBe(false);
    });
  });

  describe('stripBip141() - Reference Test Vectors', () => {
    /**
     * Test Vector 1: SRI Pool - Already Stripped
     * From: test_try_strip_bip141_sri_stripped
     */
    it('should return null for already stripped SRI coinbase (byte 4 = 0x01)', () => {
      const prefix = Buffer.from([
        2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 60, 2, 69, 8, 0,
        22, 47, 83, 116, 114, 97, 116, 117, 109, 32, 86, 50, 32, 83, 82, 73, 32, 80,
        111, 111, 108, 47,
      ]);

      const suffix = Buffer.from([
        254, 255, 255, 255, 2, 0, 242, 5, 42, 1, 0, 0, 0, 22, 0, 20, 235, 225, 183, 220,
        194, 147, 204, 170, 14, 231, 67, 168, 111, 137, 223, 130, 88, 194, 8, 252, 0, 0,
        0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113, 209,
        222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153, 98,
        180, 139, 235, 216, 54, 151, 78, 140, 249, 68, 8, 0, 0,
      ]);

      const result = stripBip141(prefix, suffix);
      expect(result).toBeNull();
    });

    /**
     * Test Vector 2: Braiins Pool - Already Stripped
     * From: test_try_strip_bip141_braiins_stripped
     */
    it('should return null for already stripped Braiins coinbase (byte 4 = 0x01)', () => {
      const prefix = Buffer.from([
        1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 37, 2, 74, 8, 4,
        242, 165, 19, 100, 8, 66, 114, 97, 105, 105, 110, 115, 0, 0, 0, 0, 0, 0, 0, 0,
        9, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);

      const suffix = Buffer.from([
        254, 255, 255, 255, 2, 128, 162, 148, 0, 0, 0, 0, 0, 22, 0, 20, 80, 56, 154, 95,
        21, 153, 218, 161, 88, 194, 17, 74, 167, 8, 145, 205, 53, 193, 170, 231, 0, 0,
        0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113, 209,
        222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153, 98,
        180, 139, 235, 216, 54, 151, 78, 140, 249, 74, 8, 0, 0,
      ]);

      const result = stripBip141(prefix, suffix);
      expect(result).toBeNull();
    });

    /**
     * Test Vector 3: SRI Pool - BEFORE Stripping (WITNESS FORMAT)
     * From: test_try_strip_bip141_sri_before_stripping
     *
     * This is the critical test - verifies actual witness stripping.
     */
    it('should correctly strip witness bytes from SRI coinbase', () => {
      // Input: 73-byte prefix with witness marker+flag at bytes 4-5
      const prefixWithWitness = Buffer.from([
        2, 0, 0, 0,    // version (4 bytes)
        0, 1,          // MARKER (0x00) + FLAG (0x01) - WILL BE REMOVED
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 60, 2, 69, 8,
        0, 22, 47, 83, 116, 114, 97, 116, 117, 109, 32, 86, 50, 32, 83, 82, 73, 32, 80,
        111, 111, 108, 47, 47, 32,
      ]);

      // Expected: 71-byte prefix (removed 2 bytes)
      const expectedPrefix = Buffer.from([
        2, 0, 0, 0,    // version (kept)
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 60, 2, 69, 8,
        0, 22, 47, 83, 116, 114, 97, 116, 117, 109, 32, 86, 50, 32, 83, 82, 73, 32, 80,
        111, 111, 108, 47, 47, 32,
      ]);

      // Input: 141-byte suffix with witness data at the end
      const suffixWithWitness = Buffer.from([
        254, 255, 255, 255, 2, 0, 242, 5, 42, 1, 0, 0, 0, 22, 0, 20, 235, 225, 183,
        220, 194, 147, 204, 170, 14, 231, 67, 168, 111, 137, 223, 130, 88, 194, 8, 252,
        0, 0, 0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113,
        209, 222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153,
        98, 180, 139, 235, 216, 54, 151, 78, 140, 249,
        1,         // witness_count = 0x01 (REMOVED)
        32,        // witness_len = 0x20 = 32 bytes (REMOVED)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 32-byte witness (REMOVED)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        68, 8, 0, 0,  // locktime (kept)
      ]);

      // Expected: 107-byte suffix (removed 34 bytes)
      const expectedSuffix = Buffer.from([
        254, 255, 255, 255, 2, 0, 242, 5, 42, 1, 0, 0, 0, 22, 0, 20, 235, 225, 183,
        220, 194, 147, 204, 170, 14, 231, 67, 168, 111, 137, 223, 130, 88, 194, 8, 252,
        0, 0, 0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113,
        209, 222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153,
        98, 180, 139, 235, 216, 54, 151, 78, 140, 249,
        68, 8, 0, 0,  // locktime (kept)
      ]);

      const result = stripBip141(prefixWithWitness, suffixWithWitness);

      // Verify stripping occurred
      expect(result).not.toBeNull();

      // Verify exact byte-for-byte match
      expect(result!.prefix).toEqual(expectedPrefix);
      expect(result!.suffix).toEqual(expectedSuffix);

      // Verify lengths
      expect(result!.prefix.length).toBe(prefixWithWitness.length - 2);  // removed marker+flag
      expect(result!.suffix.length).toBe(suffixWithWitness.length - 34); // removed witness data
    });

    /**
     * Test Vector 4: Braiins Pool - BEFORE Stripping (WITNESS FORMAT)
     * From: test_try_strip_bip141_braiins_before_stripping
     */
    it('should correctly strip witness bytes from Braiins coinbase', () => {
      // Input: 75-byte prefix with witness
      const prefixWithWitness = Buffer.from([
        1, 0, 0, 0,    // version
        0, 1,          // MARKER + FLAG (will be removed)
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 37, 2, 74, 8,
        4, 242, 165, 19, 100, 8, 66, 114, 97, 105, 105, 110, 115, 0, 0, 0, 0, 0, 0, 0,
        0, 9, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);

      // Expected: 73-byte prefix
      const expectedPrefix = Buffer.from([
        1, 0, 0, 0,    // version (kept)
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 37, 2, 74, 8,
        4, 242, 165, 19, 100, 8, 66, 114, 97, 105, 105, 110, 115, 0, 0, 0, 0, 0, 0, 0,
        0, 9, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);

      // Input: 141-byte suffix with witness
      const suffixWithWitness = Buffer.from([
        254, 255, 255, 255, 2, 128, 162, 148, 0, 0, 0, 0, 0, 22, 0, 20, 80, 56, 154,
        95, 21, 153, 218, 161, 88, 194, 17, 74, 167, 8, 145, 205, 53, 193, 170, 231, 0,
        0, 0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113,
        209, 222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153,
        98, 180, 139, 235, 216, 54, 151, 78, 140, 249,
        1,         // witness_count (removed)
        32,        // witness_len (removed)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 32-byte witness (removed)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        74, 8, 0, 0,  // locktime (kept)
      ]);

      // Expected: 107-byte suffix
      const expectedSuffix = Buffer.from([
        254, 255, 255, 255, 2, 128, 162, 148, 0, 0, 0, 0, 0, 22, 0, 20, 80, 56, 154,
        95, 21, 153, 218, 161, 88, 194, 17, 74, 167, 8, 145, 205, 53, 193, 170, 231, 0,
        0, 0, 0, 0, 0, 0, 0, 38, 106, 36, 170, 33, 169, 237, 226, 246, 28, 63, 113,
        209, 222, 253, 63, 169, 153, 223, 163, 105, 83, 117, 92, 105, 6, 137, 121, 153,
        98, 180, 139, 235, 216, 54, 151, 78, 140, 249,
        74, 8, 0, 0,  // locktime (kept)
      ]);

      const result = stripBip141(prefixWithWitness, suffixWithWitness);

      expect(result).not.toBeNull();
      expect(result!.prefix).toEqual(expectedPrefix);
      expect(result!.suffix).toEqual(expectedSuffix);
      expect(result!.prefix.length).toBe(prefixWithWitness.length - 2);  // removed marker+flag
      expect(result!.suffix.length).toBe(suffixWithWitness.length - 34); // removed witness data
    });
  });

  describe('Error Handling', () => {
    it('should throw for prefix shorter than 6 bytes', () => {
      const shortPrefix = Buffer.from([0x02, 0x00, 0x00]); // only 3 bytes
      const validSuffix = Buffer.alloc(38); // minimum valid size

      expect(() => stripBip141(shortPrefix, validSuffix)).toThrow(
        'Coinbase prefix too short',
      );
    });

    it('should throw for suffix shorter than 38 bytes', () => {
      const validPrefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x00, 0x01,             // marker + flag
      ]);
      const shortSuffix = Buffer.from([0x00, 0x00, 0x00, 0x00]); // only 4 bytes

      expect(() => stripBip141(validPrefix, shortSuffix)).toThrow(
        'Coinbase suffix too short',
      );
    });

    it('should throw for invalid witness count (not 0x01)', () => {
      const prefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x00, 0x01,             // marker + flag
      ]);

      const suffix = Buffer.alloc(40);
      suffix[40 - 38] = 0x02;  // witness_count = 0x02 (invalid, should be 0x01)
      suffix[40 - 37] = 0x20;  // witness_len = 32
      suffix.writeUInt32LE(0x12345678, 36); // locktime

      expect(() => stripBip141(prefix, suffix)).toThrow('Invalid witness count');
    });

    it('should throw for invalid witness length (not 0x20)', () => {
      const prefix = Buffer.from([
        0x02, 0x00, 0x00, 0x00, // version
        0x00, 0x01,             // marker + flag
      ]);

      const suffix = Buffer.alloc(40);
      suffix[40 - 38] = 0x01;  // witness_count = 1
      suffix[40 - 37] = 0x10;  // witness_len = 16 (invalid, should be 32)
      suffix.writeUInt32LE(0x12345678, 36); // locktime

      expect(() => stripBip141(prefix, suffix)).toThrow('Invalid witness length');
    });
  });

  describe('Idempotence', () => {
    it('should return null when called twice (already stripped)', () => {
      const prefixWithWitness = Buffer.from([
        2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);

      const suffixWithWitness = Buffer.alloc(50);
      suffixWithWitness[50 - 38] = 0x01;  // witness_count
      suffixWithWitness[50 - 37] = 0x20;  // witness_len
      suffixWithWitness.writeUInt32LE(0x12345678, 46); // locktime

      // First call: should strip
      const result1 = stripBip141(prefixWithWitness, suffixWithWitness);
      expect(result1).not.toBeNull();

      // Second call on stripped output: should return null
      const result2 = stripBip141(result1!.prefix, result1!.suffix);
      expect(result2).toBeNull();
    });
  });
});
