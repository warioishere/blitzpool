/**
 * Verify that extended block reconstruction produces a coinbase whose
 * txid matches the share-validation txid (hash256 of raw prefix+extranonce+suffix).
 *
 * If these two hashes match, the merkle root is correct, and the
 * submitted block is valid.
 *
 * Tests 8-byte (standard), 10-byte, and 12-byte (max) extranonce sizes.
 */

import * as bitcoinjs from 'bitcoinjs-lib';

// ── Helper: replicate MiningJob coinbase construction ──────────────

function buildTestCoinbase(height: number, poolTag: string): {
  coinbaseTx: bitcoinjs.Transaction;
  coinbasePrefix: Buffer;
  coinbaseSuffix: Buffer;
} {
  const tx = new bitcoinjs.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

  // Single output: 50 BTC to a dummy p2wpkh
  const dummyScript = Buffer.from('0014' + 'ab'.repeat(20), 'hex');
  tx.addOutput(dummyScript, 50_0000_0000);

  // SegWit witness commitment output (OP_RETURN)
  const witnessCommit = Buffer.alloc(32, 0xcc);
  const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
  tx.addOutput(
    bitcoinjs.script.compile([
      bitcoinjs.opcodes.OP_RETURN,
      Buffer.concat([segwitMagicBits, witnessCommit]),
    ]),
    0,
  );

  // SegWit coinbase witness
  tx.ins[0].witness = [Buffer.alloc(32, 0)];

  // Build scriptSig: BIP34 height + pool tag + 8-byte zero padding (extranonce slot)
  const heightEncoded = bitcoinjs.script.number.encode(height);
  const heightLenByte = Buffer.from([heightEncoded.length]);
  const extra = Buffer.from(poolTag);
  const padding = Buffer.alloc(8 + (3 - heightEncoded.length), 0);
  const script = Buffer.concat([heightLenByte, heightEncoded, extra, padding]);
  tx.ins[0].script = script;

  // Non-witness serialization (same as MiningJob.__toBuffer())
  // @ts-ignore – access private method
  const serializedHex: string = tx.__toBuffer().toString('hex');
  const scriptHex = script.toString('hex');
  const partOneIndex = serializedHex.indexOf(scriptHex) + scriptHex.length;

  // coinbasePart1 = everything up to 8 bytes before end of script
  // coinbasePart2 = everything after the full script (starting at sequence)
  const coinbasePrefix = Buffer.from(serializedHex.slice(0, partOneIndex - 16), 'hex');
  const coinbaseSuffix = Buffer.from(serializedHex.slice(partOneIndex), 'hex');

  return { coinbaseTx: tx, coinbasePrefix, coinbaseSuffix };
}

// ── Helper: replicate patchCoinbasePrefixVarint from StratumV2Client ──

function patchCoinbasePrefixVarint(prefix: Buffer, totalExtranonceSize: number): Buffer {
  if (totalExtranonceSize === 8) return prefix;
  const patched = Buffer.from(prefix);
  // scriptSig length varint at offset 41:
  //   version(4) + input_count(1) + prev_txid(32) + input_index(4) = 41
  patched[41] += (totalExtranonceSize - 8);
  return patched;
}

// ── Helper: replicate reconstructExtendedBlock logic ───────────────

function reconstructCoinbase(
  originalTx: bitcoinjs.Transaction,
  extranoncePrefix: Buffer,
  minerExtranonce: Buffer,
): bitcoinjs.Transaction {
  // Clone the transaction (preserving witness)
  const cloned = Object.assign(new bitcoinjs.Transaction(), originalTx);
  cloned.ins = originalTx.ins.map(inp => ({ ...inp }));
  cloned.outs = originalTx.outs.map(out => ({ ...out }));

  // Patch script: strip 8-byte slot, append actual extranonce
  const originalScript = cloned.ins[0].script;
  const scriptPrefix = originalScript.subarray(0, originalScript.length - 8);
  cloned.ins[0].script = Buffer.concat([scriptPrefix, extranoncePrefix, minerExtranonce]);

  return cloned;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Extended block reconstruction – coinbase txid consistency', () => {
  const testCases = [
    { name: '8-byte extranonce (4+4)', prefixSize: 4, minerSize: 4 },
    { name: '10-byte extranonce (4+6)', prefixSize: 4, minerSize: 6 },
    { name: '12-byte extranonce (4+8)', prefixSize: 4, minerSize: 8 },
    { name: '12-byte extranonce (6+6)', prefixSize: 6, minerSize: 6 },
  ];

  for (const tc of testCases) {
    it(`${tc.name}: reconstructed txid matches share-validation txid`, () => {
      const { coinbaseTx, coinbasePrefix: rawPrefix, coinbaseSuffix } = buildTestCoinbase(850000, 'TestPool');

      // Simulate miner extranonce values
      const extranoncePrefix = Buffer.alloc(tc.prefixSize, 0xaa);
      const minerExtranonce = Buffer.alloc(tc.minerSize, 0xbb);
      const totalExtranonceSize = tc.prefixSize + tc.minerSize;

      // Patch the scriptSig length varint (same as StratumV2Client does at job creation)
      const coinbasePrefix = patchCoinbasePrefixVarint(rawPrefix, totalExtranonceSize);

      // ── Share validation path: raw bytes → hash256 ──
      const rawCoinbaseBytes = Buffer.concat([
        coinbasePrefix,
        extranoncePrefix,
        minerExtranonce,
        coinbaseSuffix,
      ]);
      const shareValidationTxid = bitcoinjs.crypto.hash256(rawCoinbaseBytes);

      // ── Block reconstruction path: patch Transaction object → getHash ──
      const reconstructed = reconstructCoinbase(coinbaseTx, extranoncePrefix, minerExtranonce);
      // getHash(false) = non-witness txid (same as hash256 of non-witness serialization)
      const reconstructedTxid = reconstructed.getHash(false);

      expect(reconstructedTxid.toString('hex')).toEqual(shareValidationTxid.toString('hex'));
    });
  }

  it('reconstructed coinbase preserves witness data', () => {
    const { coinbaseTx } = buildTestCoinbase(850000, 'TestPool');

    const extranoncePrefix = Buffer.from('aabbccdd', 'hex');
    const minerExtranonce = Buffer.from('1122334455667788', 'hex');

    const reconstructed = reconstructCoinbase(coinbaseTx, extranoncePrefix, minerExtranonce);

    // Witness must still be present (32-byte zero reserved value)
    expect(reconstructed.ins[0].witness).toHaveLength(1);
    expect(reconstructed.ins[0].witness[0]).toEqual(Buffer.alloc(32, 0));
  });

  it('reconstructed coinbase has correct script content', () => {
    const { coinbaseTx } = buildTestCoinbase(850000, 'TestPool');

    const extranoncePrefix = Buffer.from('aabb', 'hex'); // 2 bytes
    const minerExtranonce = Buffer.from('112233445566', 'hex'); // 6 bytes

    const reconstructed = reconstructCoinbase(coinbaseTx, extranoncePrefix, minerExtranonce);

    const script = reconstructed.ins[0].script;
    // Script should end with the extranonce bytes
    const tail = script.subarray(script.length - 8);
    expect(tail.toString('hex')).toEqual('aabb112233445566');
  });

  it('non-witness serialization round-trips correctly for non-8-byte extranonce', () => {
    const { coinbaseTx, coinbasePrefix: rawPrefix, coinbaseSuffix } = buildTestCoinbase(850000, 'TestPool');

    // 12-byte extranonce (bigger than the 8-byte slot)
    const extranoncePrefix = Buffer.alloc(4, 0xaa);
    const minerExtranonce = Buffer.alloc(8, 0xbb);
    const totalExtranonceSize = 12;

    // Patch varint for 12-byte extranonce
    const coinbasePrefix = patchCoinbasePrefixVarint(rawPrefix, totalExtranonceSize);

    const reconstructed = reconstructCoinbase(coinbaseTx, extranoncePrefix, minerExtranonce);

    // Non-witness serialization via __toBuffer
    // @ts-ignore
    const nonWitnessSerialized = reconstructed.__toBuffer();

    // This should be parseable back
    const reparsed = bitcoinjs.Transaction.fromBuffer(nonWitnessSerialized);
    expect(reparsed.ins[0].script.length).toEqual(reconstructed.ins[0].script.length);

    // And the txid should match (using patched prefix for share validation)
    const rawBytes = Buffer.concat([coinbasePrefix, extranoncePrefix, minerExtranonce, coinbaseSuffix]);
    const rawTxid = bitcoinjs.crypto.hash256(rawBytes);
    expect(reparsed.getHash(false).toString('hex')).toEqual(rawTxid.toString('hex'));
  });
});
