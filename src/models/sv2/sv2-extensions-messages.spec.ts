// Tests for sv2-extensions-messages.ts — extensions negotiation (ext 0x0001)
// and Coinbase Output Weights TLV (ext 0x0003).

import { BufferReader } from './sv2-binary-codec';
import {
  deserializeRequestExtensions,
  serializeRequestExtensionsSuccess,
  serializeRequestExtensionsError,
  encodeCoinbaseOutputWeightsTlv,
  parseCoinbaseOutputWeightsTlv,
} from './sv2-extensions-messages';

describe('RequestExtensions (de)serialization', () => {
  it('round-trips a request with multiple requested extensions', () => {
    // Build the wire form manually:
    //   request_id (U16 LE) | SEQ0_64K count (U16 LE) | extension IDs (U16 LE each)
    const buf = Buffer.from([
      0x05, 0x00,             // request_id = 5
      0x02, 0x00,             // count = 2
      0x02, 0x00,             // ext 0x0002
      0x03, 0x00,             // ext 0x0003
    ]);
    const msg = deserializeRequestExtensions(new BufferReader(buf));
    expect(msg.requestId).toBe(5);
    expect(msg.requestedExtensions).toEqual([0x0002, 0x0003]);
  });

  it('handles empty requested list', () => {
    const buf = Buffer.from([0x07, 0x00, 0x00, 0x00]); // id=7, count=0
    const msg = deserializeRequestExtensions(new BufferReader(buf));
    expect(msg.requestId).toBe(7);
    expect(msg.requestedExtensions).toEqual([]);
  });

  it('serializes Success with the supported subset', () => {
    const buf = serializeRequestExtensionsSuccess({
      requestId: 9,
      supportedExtensions: [0x0003],
    });
    // U16(9) | U16(1) | U16(0x0003)
    expect(buf).toEqual(Buffer.from([0x09, 0x00, 0x01, 0x00, 0x03, 0x00]));
  });

  it('serializes Error with unsupported + required lists', () => {
    const buf = serializeRequestExtensionsError({
      requestId: 0x1234,
      unsupportedExtensions: [0x0002],
      requiredExtensions: [0x0005, 0x0006],
    });
    expect(buf).toEqual(Buffer.from([
      0x34, 0x12,                   // request_id LE
      0x01, 0x00, 0x02, 0x00,       // unsupported: count=1, [0x0002]
      0x02, 0x00, 0x05, 0x00, 0x06, 0x00, // required: count=2, [0x0005, 0x0006]
    ]));
  });
});

describe('Coinbase Output Weights TLV (ext 0x0003)', () => {
  it('matches the spec example: weights=[200, 4900, 4900]', () => {
    // Per extensions/0x0003-coinbase-output-weights.md §1.1:
    //   00 03 01 00 0E 03 00 C8 00 00 00 24 13 00 00 24 13 00 00
    const tlv = encodeCoinbaseOutputWeightsTlv([200, 4900, 4900]);
    expect(tlv.toString('hex')).toBe('000301000e0300c80000002413000024130000');
  });

  it('encodes a 2-weight TLV with correct length and headers', () => {
    const tlv = encodeCoinbaseOutputWeightsTlv([1, 99]);
    // Per spec §3.4.3: TLV header is BIG-ENDIAN, value internals LE.
    // Type 0x0003 + field 0x01           → 00 03 01 (BE)
    // Length: U16 = 2 (count) + 4*2 = 10 → 00 0a   (BE)
    // Value: count=2 (LE), then U32 LE 1, then U32 LE 99
    expect(tlv).toEqual(Buffer.from([
      0x00, 0x03, 0x01,                   // type (BE)
      0x00, 0x0a,                         // length = 10 (BE)
      0x02, 0x00,                         // count = 2 (LE)
      0x01, 0x00, 0x00, 0x00,             // weight 1 (LE)
      0x63, 0x00, 0x00, 0x00,             // weight 99 (LE)
    ]));
  });

  it('rejects zero weights (sum must be > 0 per §1.1)', () => {
    expect(() => encodeCoinbaseOutputWeightsTlv([0, 0])).toThrow(/sum of weights/);
  });

  it('rejects empty input (caller should omit TLV altogether)', () => {
    expect(() => encodeCoinbaseOutputWeightsTlv([])).toThrow(/at least one weight/);
  });

  it('rejects non-U32 weight', () => {
    expect(() => encodeCoinbaseOutputWeightsTlv([1, -1])).toThrow(/invalid weight/);
    expect(() => encodeCoinbaseOutputWeightsTlv([1, 1.5])).toThrow(/invalid weight/);
    expect(() => encodeCoinbaseOutputWeightsTlv([0x1_0000_0000])).toThrow(/invalid weight/);
  });

  it('parses a TLV back to the original weights', () => {
    const tlv = encodeCoinbaseOutputWeightsTlv([200, 4900, 4900]);
    expect(parseCoinbaseOutputWeightsTlv(tlv)).toEqual([200, 4900, 4900]);
  });

  it('returns null when no 0x0003 TLV is present', () => {
    expect(parseCoinbaseOutputWeightsTlv(Buffer.alloc(0))).toBeNull();
    // An unrelated TLV: extType=0x0009 BE, fieldType=0x01, length=2 BE, value=0x0000
    const unrelated = Buffer.from([0x00, 0x09, 0x01, 0x00, 0x02, 0x00, 0x00]);
    expect(parseCoinbaseOutputWeightsTlv(unrelated)).toBeNull();
  });

  it('parses the spec wire example back to weights=[200, 4900, 4900]', () => {
    // Verbatim from extensions/0x0003-coinbase-output-weights.md §1.1:
    const wire = Buffer.from('000301000e0300c80000002413000024130000', 'hex');
    expect(parseCoinbaseOutputWeightsTlv(wire)).toEqual([200, 4900, 4900]);
  });
});

// ── Integration: full AllocateMiningJobToken.Success + ext 0x0003 TLV ──
// Exercises the prod-code wire shape: serialize base success message,
// append the 0x0003 weights TLV (when negotiated), then parse both back.
// Catches any regression where the TLV gets corrupted by being concatenated
// onto the base payload.
describe('AllocateMiningJobToken.Success + 0x0003 TLV roundtrip', () => {
  // Production serializers used directly — no fakes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jdp = require('./sv2-jdp-messages');

  it('client can split base payload from trailing TLV bytes', () => {
    const baseMsg = {
      requestId: 0xdeadbeef,
      miningJobToken: Buffer.from('mytoken1234', 'utf8'),
      coinbaseOutputs: Buffer.from('00', 'hex'), // empty Vec<TxOut>
    };
    const baseBuf: Buffer = jdp.serializeAllocateMiningJobTokenSuccess(baseMsg);
    const tlvBuf = encodeCoinbaseOutputWeightsTlv([1, 99, 4_000_000_000]);
    const combined = Buffer.concat([baseBuf, tlvBuf]);

    // Re-parse the base portion. It should consume exactly baseBuf.length
    // bytes and leave the TLV intact at the tail.
    const reader = new BufferReader(combined);
    const parsedBase = jdp.deserializeAllocateMiningJobTokenSuccess(reader);
    expect(parsedBase.requestId).toBe(baseMsg.requestId);
    expect(parsedBase.miningJobToken).toEqual(baseMsg.miningJobToken);
    expect(parsedBase.coinbaseOutputs).toEqual(baseMsg.coinbaseOutputs);

    // The remaining bytes after base-parse should be exactly the TLV.
    const tail = combined.subarray(reader.position);
    expect(tail).toEqual(tlvBuf);
    expect(parseCoinbaseOutputWeightsTlv(tail)).toEqual([1, 99, 4_000_000_000]);
  });
});
