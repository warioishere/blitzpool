import * as bitcoinjs from 'bitcoinjs-lib';

const TRUE_DIFF_ONE_BIGINT = BigInt(
  '26959535291011309493156476344723991336010898738574164086137773096960'
);

/** 2^256 as BigInt, used for SV2 target calculations */
const TWO_TO_256 = 1n << 256n;

/**
 * 1e15 = 10^15 — largest power of ten ≤ Number.MAX_SAFE_INTEGER (2^53 ≈ 9.007e15).
 * Both 1e15 and any value < 1e15 round-trip through Number exactly.
 */
const FRACTION_SCALE = 1_000_000_000_000_000n;
const FRACTION_SCALE_NUM = 1e15;

/**
 * difficulty = TRUE_DIFF_ONE / divisor as a Number. SCALE-then-divide keeps
 * sub-unit precision for hard targets (divisor > TRUE_DIFF_ONE) and matches
 * the precision of the original big.js implementation.
 */
function bigIntRatioToDifficulty(divisor: bigint): number {
  if (divisor === 0n) return Number.MAX_SAFE_INTEGER;
  const scaled = (TRUE_DIFF_ONE_BIGINT * FRACTION_SCALE) / divisor;
  return Number(scaled) / FRACTION_SCALE_NUM;
}

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): { submissionDifficulty: number; submissionHash: string; hashBuffer: Buffer } {
    const hashResult = bitcoinjs.crypto.hash256(Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex'));
    const s64 = DifficultyUtils.le256todouble(hashResult);

    return {
      submissionDifficulty: bigIntRatioToDifficulty(s64),
      submissionHash: hashResult.toString('hex'),
      hashBuffer: hashResult,
    };
  }

  /**
   * Exact share-validity check: compare the share's header-hash against the
   * target the pool assigned at job-send. Both are 32-byte LE U256.
   *
   * Why not `submissionDifficulty >= jobDifficulty`? Because difficultyToTarget
   * uses `floor(TRUE_DIFF_ONE / D)` — the resulting target is rounded DOWN
   * (made a hair easier). A hash hitting that target round-trips through
   * targetToDifficulty back to a difficulty marginally BELOW D, which would
   * spuriously reject a share that genuinely met the target the miner was
   * given. ckpool's stratifier compares `hash ≤ target` directly for the
   * accept/reject decision (binary, exact) — this is the same approach.
   */
  static meetsTarget(hashBuffer: Buffer, target: Buffer): boolean {
    return DifficultyUtils.le256todouble(hashBuffer) <= DifficultyUtils.le256todouble(target);
  }

  /**
   * Convert a floating-point difficulty to a 32-byte LE U256 target.
   * target = floor(TRUE_DIFF_ONE / difficulty)
   * Used by SV2 which communicates targets as U256 rather than difficulty floats.
   */
  static difficultyToTarget(difficulty: number): Buffer {
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
      // Return max target (all 0xff) for invalid difficulty
      return Buffer.alloc(32, 0xff);
    }

    // Scale up to handle fractional difficulties (e.g. 0.06 for CPU miners)
    // target = TRUE_DIFF_ONE / difficulty
    const SCALE = 1_000_000n;
    const diffScaled = BigInt(Math.round(difficulty * 1_000_000));
    if (diffScaled === 0n) {
      return Buffer.alloc(32, 0xff);
    }

    const target = (TRUE_DIFF_ONE_BIGINT * SCALE) / diffScaled;

    // Convert to 32-byte LE buffer
    const buf = Buffer.alloc(32);
    let val = target;
    for (let i = 0; i < 32; i++) {
      buf[i] = Number(val & 0xffn);
      val >>= 8n;
    }
    return buf;
  }

  /**
   * Convert a 32-byte LE U256 target back to a floating-point difficulty.
   * difficulty = TRUE_DIFF_ONE / target
   */
  static targetToDifficulty(target: Buffer): number {
    if (target.length !== 32) {
      throw new Error('Target must be 32 bytes');
    }

    const targetBigint = DifficultyUtils.le256todouble(target);
    if (targetBigint === 0n) {
      return Infinity;
    }

    return bigIntRatioToDifficulty(targetBigint);
  }

  /**
   * Compute mining target from a miner's reported hashrate.
   * SV2 reference formula: target = (2^256 - h*s) / (h*s + 1)
   * where h = hashrate (H/s), s = seconds per share = 60 / sharesPerMinute.
   *
   * The miner reports nominalHashRate in OpenStandardMiningChannel /
   * OpenExtendedMiningChannel and the pool uses it to set the initial target.
   *
   * @see https://github.com/stratum-mining/sv2-spec — target.rs
   */
  static hashRateToTarget(hashRate: number, sharesPerMinute: number): Buffer {
    if (!Number.isFinite(hashRate) || hashRate <= 0 ||
        !Number.isFinite(sharesPerMinute) || sharesPerMinute <= 0) {
      return Buffer.alloc(32, 0xff);
    }

    const secondsPerShare = 60 / sharesPerMinute;
    const sh = BigInt(Math.round(hashRate * secondsPerShare));
    if (sh === 0n) {
      return Buffer.alloc(32, 0xff);
    }

    // t = (2^256 - sh) / (sh + 1)
    const target = (TWO_TO_256 - sh) / (sh + 1n);

    // Clamp to max U256
    const maxU256 = TWO_TO_256 - 1n;
    const clamped = target > maxU256 ? maxU256 : target;

    const buf = Buffer.alloc(32);
    let val = clamped;
    for (let i = 0; i < 32; i++) {
      buf[i] = Number(val & 0xffn);
      val >>= 8n;
    }
    return buf;
  }

  /**
   * Compute pdiff difficulty from a miner's reported hashrate.
   * hashRate → target (SV2 formula) → pdiff difficulty.
   */
  static hashRateToDifficulty(hashRate: number, sharesPerMinute: number): number {
    const target = DifficultyUtils.hashRateToTarget(hashRate, sharesPerMinute);
    return DifficultyUtils.targetToDifficulty(target);
  }

  /**
   * Clamp a computed difficulty so the resulting target does not exceed maxTarget.
   * SV2 spec: the server must not assign a target above the client's declared maximum.
   * A higher target value = easier work, so if our computed target exceeds maxTarget,
   * we use the harder difficulty corresponding to maxTarget instead.
   */
  static clampDifficultyToMaxTarget(difficulty: number, maxTarget: Buffer): number {
    if (maxTarget.length !== 32) return difficulty;

    const maxTargetBigInt = DifficultyUtils.le256todouble(maxTarget);
    if (maxTargetBigInt === 0n) return difficulty;

    const computedTarget = DifficultyUtils.difficultyToTarget(difficulty);
    const computedBigInt = DifficultyUtils.le256todouble(computedTarget);

    if (computedBigInt > maxTargetBigInt) {
      const clamped = DifficultyUtils.targetToDifficulty(maxTarget);
      return Number.isFinite(clamped) && clamped > 0 ? clamped : difficulty;
    }
    return difficulty;
  }

  private static le256todouble(target: Buffer): bigint {
    const number = target.reduceRight((acc, byte) => {
      return (acc << BigInt(8)) | BigInt(byte);
    }, BigInt(0));
    return number;
  }
}
