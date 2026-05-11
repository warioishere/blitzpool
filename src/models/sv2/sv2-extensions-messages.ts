// ── SV2 Extensions Negotiation Messages (sv2-spec ext 0x0001) ──────
// Defines RequestExtensions / RequestExtensions.Success / .Error and
// the TLV encoder for ext 0x0003 (Coinbase Output Weights).
//
// All RequestExtensions* messages MUST be carried in frames whose
// header extension_type field is SV2_EXTENSION_TYPE_NEGOTIATION
// (0x0001), since that extension introduced them. The TLV for
// 0x0003 piggy-backs on AllocateMiningJobToken.Success, whose
// frame retains extension_type = 0x0000 per the 0x0003 spec §3.

import { BufferReader, BufferWriter } from './sv2-binary-codec';
import {
  SV2_EXTENSION_TYPE_COINBASE_OUTPUT_WEIGHTS,
  SV2_FIELD_TYPE_COINBASE_TX_OUTPUT_WEIGHTS,
} from './sv2-constants';

// ── RequestExtensions (msgType 0x00, ext_type 0x0001) ──────────────

export interface Sv2RequestExtensions {
  requestId: number;             // U16
  requestedExtensions: number[]; // SEQ0_64K[U16]
}

export function deserializeRequestExtensions(reader: BufferReader): Sv2RequestExtensions {
  return {
    requestId: reader.readU16(),
    requestedExtensions: reader.readSeq0_64K((r) => r.readU16()),
  };
}

// ── RequestExtensions.Success (msgType 0x01, ext_type 0x0001) ──────

export interface Sv2RequestExtensionsSuccess {
  requestId: number;
  supportedExtensions: number[];
}

export function serializeRequestExtensionsSuccess(msg: Sv2RequestExtensionsSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU16(msg.requestId);
  w.writeSeq0_64K(msg.supportedExtensions, (writer, v) => writer.writeU16(v));
  return w.toBuffer();
}

// ── RequestExtensions.Error (msgType 0x02, ext_type 0x0001) ────────

export interface Sv2RequestExtensionsError {
  requestId: number;
  unsupportedExtensions: number[];
  requiredExtensions: number[]; // server-side requirements not requested by client
}

export function serializeRequestExtensionsError(msg: Sv2RequestExtensionsError): Buffer {
  const w = new BufferWriter();
  w.writeU16(msg.requestId);
  w.writeSeq0_64K(msg.unsupportedExtensions, (writer, v) => writer.writeU16(v));
  w.writeSeq0_64K(msg.requiredExtensions, (writer, v) => writer.writeU16(v));
  return w.toBuffer();
}

// ── Coinbase Output Weights TLV (ext 0x0003 §1.1) ──────────────────
//
// Encoded shape:
//   [Type: ext_type U16-BE | field_type U8] [Length U16-BE] [Value: SEQ0_64K[U32]]
//
// IMPORTANT — endianness note: per §3.4.3 of the SV2 spec and the
// wire example below, the TLV *header* (Type + Length) is encoded
// big-endian (network byte order), even though the rest of SV2
// uses little-endian. The Value's internal SEQ0_64K count (U16) and
// each U32 weight remain little-endian.
//
// Wire example from the spec for weights=[200, 4900, 4900]:
//   00 03 01 00 0E 03 00 C8 00 00 00 24 13 00 00 24 13 00 00
//   └────┴──┘ └────┘ └────┘ └─weight[0]─┘ └─weight[1]─┘ └─weight[2]─┘
//   ext  fld  length count
//   0x0003 BE 14 BE  3 LE
//
// Returns the raw TLV bytes — caller appends to AllocateMiningJobToken.Success.

export function encodeCoinbaseOutputWeightsTlv(weights: ReadonlyArray<number>): Buffer {
  if (weights.length === 0) {
    // Spec §1.1: empty array is "equivalent to the extension being absent
    // for that token". Caller decides whether to send the TLV at all.
    throw new RangeError('encodeCoinbaseOutputWeightsTlv requires at least one weight');
  }
  if (weights.length > 0xffff) {
    throw new RangeError(`weights.length ${weights.length} exceeds SEQ0_64K cap`);
  }

  // Validate each weight fits in U32, and sum > 0 (spec constraints).
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) {
      throw new RangeError(`invalid weight (must be U32): ${w}`);
    }
    sum += w;
  }
  if (sum === 0) {
    throw new RangeError('sum of weights must be > 0');
  }

  // Value = U16 count + N×U32 weights (all LE).
  const valueLen = 2 + 4 * weights.length;
  const buf = Buffer.alloc(3 + 2 + valueLen);

  let o = 0;
  // Type: U16 extension ID (BIG-ENDIAN per §3.4.3) + U8 field ID.
  buf.writeUInt16BE(SV2_EXTENSION_TYPE_COINBASE_OUTPUT_WEIGHTS, o); o += 2;
  buf.writeUInt8(SV2_FIELD_TYPE_COINBASE_TX_OUTPUT_WEIGHTS, o); o += 1;
  // Length: U16 BIG-ENDIAN per §3.4.3.
  buf.writeUInt16BE(valueLen, o); o += 2;
  // Value: SEQ0_64K count (LE).
  buf.writeUInt16LE(weights.length, o); o += 2;
  for (const w of weights) {
    buf.writeUInt32LE(w, o);
    o += 4;
  }

  return buf;
}

/**
 * Parse a Coinbase Output Weights TLV out of a tail buffer (the bytes
 * appended after the base AllocateMiningJobToken.Success serialization).
 * Returns the weights array, or `null` if no 0x0003 TLV is present.
 *
 * Tolerant of other (unknown) TLVs preceding/following — per the
 * 0x0001 spec, receivers MUST ignore TLVs for non-negotiated
 * extensions. This implementation skips unknown TLVs by length.
 */
export function parseCoinbaseOutputWeightsTlv(tail: Buffer): number[] | null {
  let o = 0;
  while (o + 5 <= tail.length) {
    const extType = tail.readUInt16BE(o);
    const fieldType = tail.readUInt8(o + 2);
    const length = tail.readUInt16BE(o + 3);
    const valueStart = o + 5;
    const valueEnd = valueStart + length;
    if (valueEnd > tail.length) return null; // malformed
    if (
      extType === SV2_EXTENSION_TYPE_COINBASE_OUTPUT_WEIGHTS &&
      fieldType === SV2_FIELD_TYPE_COINBASE_TX_OUTPUT_WEIGHTS
    ) {
      const value = tail.subarray(valueStart, valueEnd);
      if (value.length < 2) return null;
      const count = value.readUInt16LE(0);
      if (value.length !== 2 + 4 * count) return null;
      const weights: number[] = new Array(count);
      for (let i = 0; i < count; i++) {
        weights[i] = value.readUInt32LE(2 + 4 * i);
      }
      return weights;
    }
    o = valueEnd;
  }
  return null;
}
