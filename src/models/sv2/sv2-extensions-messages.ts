// ── SV2 Extensions Messages ────────────────────────────────────────
//
// This module defines the wire codecs for:
//
//   • Ext 0x0001 (Extensions Negotiation):
//       - RequestExtensions / .Success / .Error
//
//   • Ext 0x0002 (Worker-Specific Hashrate Tracking):
//       - Worker-ID TLV on SubmitSharesExtended
//
//   • Ext 0x0003 (Dynamic Coinbase Outputs):
//       - RequestCoinbaseOutputs / .Success / .Error
//
// Frames for 0x0001 and 0x0003 messages carry extension_type set to
// the extension's identifier (NOT 0x0000) because both extensions
// introduce new messages. Worker-ID TLV piggy-backs on the existing
// SubmitSharesExtended message, whose frame retains extension_type
// = 0x0000.

import { BufferReader, BufferWriter } from './sv2-binary-codec';
import {
  SV2_EXTENSION_TYPE_WORKER_ID,
  SV2_FIELD_TYPE_USER_IDENTITY,
  SV2_USER_IDENTITY_MAX_BYTES,
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

// ── Dynamic Coinbase Outputs Messages (ext 0x0003) ─────────────────
//
// Three new request/response messages introduced by ext 0x0003. Frame
// extension_type = 0x0003. Message-type codes are extension-local:
//   0x00 RequestCoinbaseOutputs         (JDC → JDS)
//   0x01 RequestCoinbaseOutputs.Success (JDS → JDC)
//   0x02 RequestCoinbaseOutputs.Error   (JDS → JDC)
//
// All payload fields use the standard SV2 little-endian encoding.
// Unlike TLV extensions there is no big-endian header — these are
// regular SV2 messages.

export interface Sv2RequestCoinbaseOutputs {
  requestId: number;          // U32
  miningJobToken: Buffer;     // B0_255
  prevHash: Buffer;           // U256 (raw 32 bytes, internal byte order)
  poolRevenue: bigint;        // U64
}

export function deserializeRequestCoinbaseOutputs(reader: BufferReader): Sv2RequestCoinbaseOutputs {
  return {
    requestId: reader.readU32(),
    miningJobToken: reader.readB0_255(),
    prevHash: reader.readU256(),
    poolRevenue: reader.readU64(),
  };
}

export function serializeRequestCoinbaseOutputs(msg: Sv2RequestCoinbaseOutputs): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeB0_255(msg.miningJobToken);
  w.writeU256(msg.prevHash);
  w.writeU64(msg.poolRevenue);
  return w.toBuffer();
}

export interface Sv2RequestCoinbaseOutputsSuccess {
  requestId: number;          // U32
  coinbaseTxOutputs: Buffer;  // B0_64K — consensus-serialized TxOut[]
}

export function serializeRequestCoinbaseOutputsSuccess(msg: Sv2RequestCoinbaseOutputsSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeB0_64K(msg.coinbaseTxOutputs);
  return w.toBuffer();
}

export function deserializeRequestCoinbaseOutputsSuccess(reader: BufferReader): Sv2RequestCoinbaseOutputsSuccess {
  return {
    requestId: reader.readU32(),
    coinbaseTxOutputs: reader.readB0_64K(),
  };
}

/** Error codes defined by ext 0x0003 §2.3. */
export type Sv2RequestCoinbaseOutputsErrorCode =
  | 'invalid-mining-job-token'
  | 'stale-prev-hash'
  | 'revenue-too-large'
  | 'coinbase-size-budget-exceeded'
  | 'internal';

export interface Sv2RequestCoinbaseOutputsError {
  requestId: number;                            // U32
  errorCode: Sv2RequestCoinbaseOutputsErrorCode | string; // STR0_255
}

export function serializeRequestCoinbaseOutputsError(msg: Sv2RequestCoinbaseOutputsError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeRequestCoinbaseOutputsError(reader: BufferReader): Sv2RequestCoinbaseOutputsError {
  return {
    requestId: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}

// ── Worker-ID TLV (ext 0x0002 §1.1) ────────────────────────────────
//
// Encoded shape (TLV header is BIG-ENDIAN per §3.4.3, value is UTF-8):
//   [Type: ext_type U16-BE | field_type U8] [Length U16-BE] [UTF-8 bytes]
//
// Spec wire example for "Worker_001" (§2):
//   00 02 01 00 0A 57 6F 72 6B 65 72 5F 30 30 31
//
// Max length: 32 bytes (spec §1.1). No padding.

export function encodeWorkerIdTlv(userIdentity: string): Buffer {
  const value = Buffer.from(userIdentity, 'utf8');
  if (value.length === 0) {
    throw new RangeError('user_identity must not be empty');
  }
  if (value.length > SV2_USER_IDENTITY_MAX_BYTES) {
    throw new RangeError(`user_identity ${value.length} bytes exceeds spec max ${SV2_USER_IDENTITY_MAX_BYTES}`);
  }
  const buf = Buffer.alloc(3 + 2 + value.length);
  let o = 0;
  buf.writeUInt16BE(SV2_EXTENSION_TYPE_WORKER_ID, o); o += 2;
  buf.writeUInt8(SV2_FIELD_TYPE_USER_IDENTITY, o); o += 1;
  buf.writeUInt16BE(value.length, o); o += 2;
  value.copy(buf, o);
  return buf;
}

/**
 * Parse a Worker-ID TLV from a tail buffer (bytes appended after the
 * base SubmitSharesExtended serialization). Returns the user_identity
 * string, or `null` if no 0x0002 TLV is present.
 *
 * Unknown TLVs are skipped per ext 0x0001 §3 (receivers MUST ignore
 * unexpected TLVs). Same big-endian header convention as 0x0003.
 *
 * Returns null on malformed TLV (truncated header / value, length cap
 * exceeded). Callers SHOULD treat a malformed TLV the same as missing
 * — fall back to the channel-default identity rather than rejecting
 * the share, since the share itself is structurally valid.
 */
export function parseWorkerIdTlv(tail: Buffer): string | null {
  let o = 0;
  while (o + 5 <= tail.length) {
    const extType = tail.readUInt16BE(o);
    const fieldType = tail.readUInt8(o + 2);
    const length = tail.readUInt16BE(o + 3);
    const valueStart = o + 5;
    const valueEnd = valueStart + length;
    if (valueEnd > tail.length) return null;
    if (
      extType === SV2_EXTENSION_TYPE_WORKER_ID &&
      fieldType === SV2_FIELD_TYPE_USER_IDENTITY
    ) {
      if (length === 0 || length > SV2_USER_IDENTITY_MAX_BYTES) return null;
      return tail.subarray(valueStart, valueEnd).toString('utf8');
    }
    o = valueEnd;
  }
  return null;
}

/**
 * Decide which worker name to attribute a share to, given a possibly
 * present ext 0x0002 Worker-ID TLV on SubmitSharesExtended.
 *
 * Semantics:
 *   - If ext 0x0002 isn't negotiated → channel default. The TLV (if
 *     any) is silently ignored per ext 0x0001 §3.
 *   - If the TLV is missing or malformed → channel default.
 *   - If the TLV's user_identity is bare ("workerName") → that's the
 *     worker, channel address is implicit.
 *   - If user_identity is "<address>.<worker>" → use the worker part
 *     ONLY when the address matches the channel-locked one. Otherwise
 *     fall back to channel default (cross-account attribution is a
 *     security boundary — a multiplexing proxy must stay within the
 *     address it opened the channel under).
 *
 * Pure function: easy to unit-test and reuse across SV1/SV2 if we
 * ever wire 0x0002 into other share paths.
 */
export function resolveShareWorkerNameFromTlv(opts: {
  tail: Buffer;
  channelAddress: string | null;
  channelWorker: string;
  ext0x0002Negotiated: boolean;
}): string {
  if (!opts.ext0x0002Negotiated) return opts.channelWorker;
  if (opts.tail.length === 0) return opts.channelWorker;

  const userIdentity = parseWorkerIdTlv(opts.tail);
  if (!userIdentity) return opts.channelWorker;

  const dot = userIdentity.indexOf('.');
  if (dot < 0) {
    return userIdentity.length > 0 ? userIdentity : opts.channelWorker;
  }

  const tlvAddress = userIdentity.substring(0, dot).toLowerCase();
  const tlvWorker = userIdentity.substring(dot + 1);
  if (opts.channelAddress && tlvAddress !== opts.channelAddress.toLowerCase()) {
    // Cross-account attribution — silently drop.
    return opts.channelWorker;
  }
  return tlvWorker.length > 0 ? tlvWorker : opts.channelWorker;
}
