import Big from 'big.js';
import * as bitcoinjs from 'bitcoinjs-lib';

const TRUE_DIFF_ONE = Big(
  '26959535291011309493156476344723991336010898738574164086137773096960'
);

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): { submissionDifficulty: number; submissionHash: string } {
    const hashResult = bitcoinjs.crypto.hash256(Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex'));
    const s64 = DifficultyUtils.le256todouble(hashResult);
    const difficulty = TRUE_DIFF_ONE.div(s64.toString());
    
    return { 
      submissionDifficulty: difficulty.toNumber(), 
      submissionHash: hashResult.toString('hex') 
    };
  }

  private static le256todouble(target: Buffer): bigint {
    const number = target.reduceRight((acc, byte) => {
      return (acc << BigInt(8)) | BigInt(byte);
    }, BigInt(0));
    return number;
  }
}
