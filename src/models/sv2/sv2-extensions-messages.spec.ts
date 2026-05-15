// Tests for sv2-extensions-messages.ts — extensions negotiation (ext 0x0001),
// Worker-ID TLV (ext 0x0002), and Dynamic Coinbase Outputs messages (ext 0x0003).

import { BufferReader } from './sv2-binary-codec';
import {
  deserializeRequestExtensions,
  serializeRequestExtensionsSuccess,
  serializeRequestExtensionsError,
  deserializeRequestCoinbaseOutputs,
  serializeRequestCoinbaseOutputs,
  serializeRequestCoinbaseOutputsSuccess,
  deserializeRequestCoinbaseOutputsSuccess,
  serializeRequestCoinbaseOutputsError,
  deserializeRequestCoinbaseOutputsError,
  encodeWorkerIdTlv,
  parseWorkerIdTlv,
  resolveShareWorkerNameFromTlv,
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

describe('RequestCoinbaseOutputs (ext 0x0003) — Request codec', () => {
  it('round-trips request_id, token, prev_hash, pool_revenue', () => {
    const prevHash = Buffer.alloc(32, 0);
    // Mark a few bytes to verify they survive the round-trip in raw order.
    prevHash[0] = 0xaa; prevHash[1] = 0xbb; prevHash[31] = 0xff;

    const original = {
      requestId: 0xdeadbeef,
      miningJobToken: Buffer.from('jdp-token-42', 'utf8'),
      prevHash,
      poolRevenue: 312_500_000n, // 3.125 BTC in sats (subsidy + fees)
    };

    const wire = serializeRequestCoinbaseOutputs(original);
    const parsed = deserializeRequestCoinbaseOutputs(new BufferReader(wire));

    expect(parsed.requestId).toBe(original.requestId);
    expect(parsed.miningJobToken).toEqual(original.miningJobToken);
    expect(parsed.prevHash).toEqual(prevHash);
    expect(parsed.poolRevenue).toBe(original.poolRevenue);
  });

  it('wire layout: U32-LE request_id, B0_255 token, U256 prev_hash, U64-LE pool_revenue', () => {
    const token = Buffer.from([0xde, 0xad]);                  // 2 bytes
    const prevHash = Buffer.alloc(32, 0x11);                  // 32x 0x11
    const wire = serializeRequestCoinbaseOutputs({
      requestId: 0x01020304,
      miningJobToken: token,
      prevHash,
      poolRevenue: 0x0000000099887766n,
    });

    // 4 (U32) + 1 (token length prefix) + 2 (token bytes) + 32 (prev_hash) + 8 (U64) = 47
    expect(wire.length).toBe(47);
    expect(wire.subarray(0, 4)).toEqual(Buffer.from([0x04, 0x03, 0x02, 0x01])); // request_id LE
    expect(wire[4]).toBe(0x02);                                                  // token length prefix
    expect(wire.subarray(5, 7)).toEqual(token);                                  // token bytes
    expect(wire.subarray(7, 39)).toEqual(prevHash);                              // prev_hash 32 bytes
    expect(wire.subarray(39, 47)).toEqual(Buffer.from([
      0x66, 0x77, 0x88, 0x99, 0x00, 0x00, 0x00, 0x00,                            // pool_revenue LE
    ]));
  });
});

describe('RequestCoinbaseOutputs.Success (ext 0x0003) — Response codec', () => {
  it('round-trips request_id and consensus-serialized outputs', () => {
    // Minimal valid Vec<TxOut>: 1 output, value=0, empty script
    // VarInt count=1, U64 value=0, VarInt script_len=0
    const coinbaseTxOutputs = Buffer.from([
      0x01,                                                  // VarInt count = 1
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,        // U64 value = 0
      0x00,                                                  // VarInt script_len = 0
    ]);

    const wire = serializeRequestCoinbaseOutputsSuccess({
      requestId: 7,
      coinbaseTxOutputs,
    });
    const parsed = deserializeRequestCoinbaseOutputsSuccess(new BufferReader(wire));
    expect(parsed.requestId).toBe(7);
    expect(parsed.coinbaseTxOutputs).toEqual(coinbaseTxOutputs);
  });

  it('wire layout: U32-LE request_id followed by B0_64K outputs', () => {
    const outputs = Buffer.from([0xAA, 0xBB, 0xCC]);
    const wire = serializeRequestCoinbaseOutputsSuccess({
      requestId: 0x42,
      coinbaseTxOutputs: outputs,
    });
    // 4 (U32) + 2 (B0_64K length prefix) + 3 (outputs) = 9
    expect(wire.length).toBe(9);
    expect(wire.subarray(0, 4)).toEqual(Buffer.from([0x42, 0x00, 0x00, 0x00])); // request_id LE
    expect(wire.subarray(4, 6)).toEqual(Buffer.from([0x03, 0x00]));             // length = 3 LE
    expect(wire.subarray(6, 9)).toEqual(outputs);
  });
});

describe('RequestCoinbaseOutputs.Error (ext 0x0003) — Error codec', () => {
  it('round-trips each defined error code', () => {
    const codes = [
      'invalid-mining-job-token',
      'stale-prev-hash',
      'revenue-too-large',
      'coinbase-size-budget-exceeded',
      'internal',
    ] as const;

    for (const code of codes) {
      const wire = serializeRequestCoinbaseOutputsError({ requestId: 1, errorCode: code });
      const parsed = deserializeRequestCoinbaseOutputsError(new BufferReader(wire));
      expect(parsed.requestId).toBe(1);
      expect(parsed.errorCode).toBe(code);
    }
  });

  it('wire layout: U32-LE request_id followed by STR0_255 error_code', () => {
    const wire = serializeRequestCoinbaseOutputsError({
      requestId: 0xCAFEBABE,
      errorCode: 'stale-prev-hash',
    });
    // 4 (U32) + 1 (STR length prefix) + 15 ("stale-prev-hash") = 20
    expect(wire.length).toBe(20);
    expect(wire.subarray(0, 4)).toEqual(Buffer.from([0xBE, 0xBA, 0xFE, 0xCA])); // LE
    expect(wire[4]).toBe(15);                                                    // string length
    expect(wire.subarray(5, 20).toString('utf8')).toBe('stale-prev-hash');
  });
});

describe('Worker-ID TLV (ext 0x0002)', () => {
  it('matches the spec wire example: "Worker_001"', () => {
    // Per extensions/0x0002-worker-specific-hashrate-tracking.md §2:
    //   00 02 01 00 0A 57 6F 72 6B 65 72 5F 30 30 31
    const tlv = encodeWorkerIdTlv('Worker_001');
    expect(tlv.toString('hex')).toBe('000201000a576f726b65725f303031');
  });

  it('round-trips arbitrary UTF-8', () => {
    const tlv = encodeWorkerIdTlv('rig.€42'); // UTF-8 multibyte
    expect(parseWorkerIdTlv(tlv)).toBe('rig.€42');
  });

  it('rejects empty user_identity at encode', () => {
    expect(() => encodeWorkerIdTlv('')).toThrow(/must not be empty/);
  });

  it('rejects > 32 byte user_identity at encode (spec §1.1)', () => {
    const tooLong = 'x'.repeat(33);
    expect(() => encodeWorkerIdTlv(tooLong)).toThrow(/exceeds spec max/);
  });

  it('parser returns null on > 32 byte declared length (malformed)', () => {
    // Forge a TLV header claiming length=33.
    const buf = Buffer.from([0x00, 0x02, 0x01, 0x00, 0x21, ...new Uint8Array(33).fill(0x41)]);
    expect(parseWorkerIdTlv(buf)).toBeNull();
  });

  it('returns null when no 0x0002 TLV is present', () => {
    expect(parseWorkerIdTlv(Buffer.alloc(0))).toBeNull();
    // An unrelated TLV (extType=0x0099 BE).
    expect(parseWorkerIdTlv(Buffer.from([0x00, 0x99, 0x01, 0x00, 0x01, 0x42]))).toBeNull();
  });

  it('skips unknown leading TLVs and finds the 0x0002 one', () => {
    // Unknown TLV first (ext=0x0099, field=0x01, len=4, value=0x00000000), then 0x0002.
    const unknown = Buffer.from([0x00, 0x99, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const ours = encodeWorkerIdTlv('rig42');
    expect(parseWorkerIdTlv(Buffer.concat([unknown, ours]))).toBe('rig42');
  });
});

describe('resolveShareWorkerNameFromTlv', () => {
  // Short test addresses so "<address>.<worker>" stays under the
  // 32-byte user_identity cap (spec §1.1). Real mainnet bech32
  // addresses are 42 chars and only fit as bare worker names —
  // see the "bare worker" test below for the realistic case.
  const channelAddress = 'addr1';
  const channelWorker = 'default';

  it('returns channel default when ext 0x0002 not negotiated (TLV ignored)', () => {
    const tail = encodeWorkerIdTlv('hacker.evil');
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: false,
    });
    expect(r).toBe(channelWorker);
  });

  it('returns channel default when no TLV present', () => {
    const r = resolveShareWorkerNameFromTlv({
      tail: Buffer.alloc(0),
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe(channelWorker);
  });

  it('accepts bare worker name (no address prefix)', () => {
    const tail = encodeWorkerIdTlv('rig42');
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe('rig42');
  });

  it('accepts "<channelAddress>.<worker>" form and returns just the worker', () => {
    const tail = encodeWorkerIdTlv(`${channelAddress}.rig42`);
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe('rig42');
  });

  it('SECURITY: drops cross-account TLV (address mismatch) → channel default', () => {
    const tail = encodeWorkerIdTlv('addr2.victim');
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe(channelWorker);
  });

  it('SECURITY: address-match check is case-insensitive (bech32 lowercase)', () => {
    const upper = channelAddress.toUpperCase();
    const tail = encodeWorkerIdTlv(`${upper}.rig`);
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress, // stored lowercase
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe('rig');
  });

  it('handles trailing-dot edge case ("addr.") → channel default (empty worker)', () => {
    const tail = encodeWorkerIdTlv(`${channelAddress}.`);
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe(channelWorker);
  });

  it('preserves nested dots in worker name ("addr.a.b" → "a.b")', () => {
    const tail = encodeWorkerIdTlv(`${channelAddress}.farm.rig5`);
    const r = resolveShareWorkerNameFromTlv({
      tail,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe('farm.rig5');
  });

  it('malformed TLV (truncated) → channel default, share remains accountable', () => {
    // Truncated 0x0002 TLV: claims length=10 but only 5 bytes follow.
    const malformed = Buffer.from([0x00, 0x02, 0x01, 0x00, 0x0a, 0x41, 0x42, 0x43, 0x44, 0x45]);
    const r = resolveShareWorkerNameFromTlv({
      tail: malformed,
      channelAddress,
      channelWorker,
      ext0x0002Negotiated: true,
    });
    expect(r).toBe(channelWorker);
  });
});
