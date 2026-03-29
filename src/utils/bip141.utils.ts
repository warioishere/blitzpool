/**
 * BIP141 Witness Stripping for SV2 Extended Channels
 *
 * This module strips witness marker/flag bytes from coinbase transactions
 * to convert SegWit format to non-witness format for merkle root calculation.
 *
 * Reference: stratum/sv2/channels-sv2/src/lib/bip141.rs
 *
 * ## Witness Format Structure
 *
 * Prefix (with witness):
 *   [version:4][MARKER:1=0x00][FLAG:1=0x01][input_count:var][inputs...]
 *
 * Prefix (stripped):
 *   [version:4][input_count:var][inputs...]
 *
 * Suffix (with witness):
 *   [...outputs...][witness_count:1=0x01][witness_len:1=0x20][witness:32][locktime:4]
 *
 * Suffix (stripped):
 *   [...outputs...][locktime:4]
 *
 * Total bytes removed: 2 (prefix) + 34 (suffix) = 36 bytes
 */

const MARKER_OFFSET = 4;          // Witness marker at byte 4 (after version)
const FLAG_OFFSET = 5;            // Witness flag at byte 5
const MARKER_FLAG_LEN = 2;        // Marker + flag = 2 bytes
const WITNESS_COUNT_LEN = 1;      // 1 byte (0x01)
const WITNESS_LEN_LEN = 1;        // 1 byte (0x20 = 32)
const WITNESS_DATA_LEN = 32;      // 32 bytes of witness commitment
const LOCKTIME_LEN = 4;           // 4 bytes
const WITNESS_TOTAL_LEN = WITNESS_COUNT_LEN + WITNESS_LEN_LEN + WITNESS_DATA_LEN; // 34 bytes

const MIN_PREFIX_LEN = 6;         // version(4) + marker(1) + flag(1)
const MIN_SUFFIX_LEN = WITNESS_TOTAL_LEN + LOCKTIME_LEN; // 34 + 4 = 38 bytes

export interface Bip141StrippedCoinbase {
  prefix: Buffer;
  suffix: Buffer;
}

/**
 * Detects and strips BIP141 witness bytes from coinbase prefix and suffix.
 *
 * Detection:
 * - Byte 4 (MARKER_OFFSET) MUST be 0x00 (witness marker)
 * - Byte 5 (FLAG_OFFSET) MUST be non-zero (witness flag, typically 0x01)
 *
 * Stripping:
 * - Prefix: Remove bytes 4-5 (marker + flag)
 * - Suffix: Remove last 34 bytes before locktime (witness_count + witness_len + witness_data)
 *
 * @param coinbasePrefix The coinbase transaction prefix (up to extranonce boundary)
 * @param coinbaseSuffix The coinbase transaction suffix (after extranonce boundary)
 * @returns Stripped prefix and suffix, or null if already non-witness format
 * @throws Error if buffers are too short or witness structure is invalid
 */
export function stripBip141(
  coinbasePrefix: Buffer,
  coinbaseSuffix: Buffer,
): Bip141StrippedCoinbase | null {
  // Validate minimum prefix length
  if (coinbasePrefix.length < MIN_PREFIX_LEN) {
    throw new Error(
      `Coinbase prefix too short for witness detection: ${coinbasePrefix.length} bytes (need ${MIN_PREFIX_LEN})`,
    );
  }

  // Detect BIP141 witness marker and flag
  const hasWitnessMarker = coinbasePrefix[MARKER_OFFSET] === 0x00;
  const hasWitnessFlag = coinbasePrefix[FLAG_OFFSET] !== 0x00;

  if (!hasWitnessMarker || !hasWitnessFlag) {
    // Already stripped or non-witness transaction
    return null;
  }

  // Now validate suffix length (only if we detected witness bytes)
  if (coinbaseSuffix.length < MIN_SUFFIX_LEN) {
    throw new Error(
      `Coinbase suffix too short for witness stripping: ${coinbaseSuffix.length} bytes (need ${MIN_SUFFIX_LEN})`,
    );
  }

  // Validate witness structure in suffix
  const locktimePosition = coinbaseSuffix.length - LOCKTIME_LEN;
  const witnessCountPosition = locktimePosition - WITNESS_TOTAL_LEN;
  const witnessLenPosition = witnessCountPosition + WITNESS_COUNT_LEN;

  const witnessCount = coinbaseSuffix[witnessCountPosition];
  const witnessLen = coinbaseSuffix[witnessLenPosition];

  // Validate witness structure (coinbase should have exactly 1 witness of 32 bytes)
  if (witnessCount !== 0x01) {
    throw new Error(
      `Invalid witness count: expected 0x01, got 0x${witnessCount.toString(16).padStart(2, '0')}`,
    );
  }

  if (witnessLen !== 0x20) {
    throw new Error(
      `Invalid witness length: expected 0x20 (32 bytes), got 0x${witnessLen.toString(16).padStart(2, '0')}`,
    );
  }

  // Strip prefix: Remove marker + flag (bytes 4-5)
  const strippedPrefix = Buffer.concat([
    coinbasePrefix.subarray(0, MARKER_OFFSET),           // version (bytes 0-3)
    coinbasePrefix.subarray(MARKER_OFFSET + MARKER_FLAG_LEN), // rest after marker+flag
  ]);

  // Strip suffix: Remove witness data, keep locktime
  const strippedSuffix = Buffer.concat([
    coinbaseSuffix.subarray(0, witnessCountPosition),    // outputs
    coinbaseSuffix.subarray(locktimePosition),           // locktime (4 bytes)
  ]);

  return {
    prefix: strippedPrefix,
    suffix: strippedSuffix,
  };
}

/**
 * Checks if a coinbase prefix contains BIP141 witness marker/flag bytes.
 *
 * @param coinbasePrefix The coinbase transaction prefix
 * @returns true if witness bytes are present, false otherwise
 */
export function hasWitnessBytes(coinbasePrefix: Buffer): boolean {
  if (coinbasePrefix.length < MIN_PREFIX_LEN) {
    return false;
  }

  return (
    coinbasePrefix[MARKER_OFFSET] === 0x00 &&
    coinbasePrefix[FLAG_OFFSET] !== 0x00
  );
}
