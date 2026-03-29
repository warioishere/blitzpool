// ── SV2 Noise NX Handshake & Encrypted Transport ────────────────────
// Implements Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256 for SV2.
// Server (responder) side: receives Act 1, sends Act 2, then
// encrypted transport in both directions.

import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import {
  SV2_NOISE_PROTOCOL_NAME,
  SV2_NOISE_PROTOCOL_NAME_AESGCM,
  SV2_NOISE_PROTOCOL_NAME_X25519_AESGCM,
  SV2_NOISE_PROTOCOL_NAME_X25519_CHACHA,
  SV2_NOISE_PROTOCOL_NAME_X25519_AESGCM_BLAKE2S,
  SV2_ELLSWIFT_KEY_SIZE,
  SV2_X25519_KEY_SIZE,
  SV2_MAC_SIZE,
  SV2_SIGNATURE_NOISE_MSG_SIZE,
  SV2_SIGNATURE_NOISE_MSG_SIZE_BRAIINS,
} from './sv2-constants';

// ── Cipher Algorithm Type ───────────────────────────────────────────

export type Sv2CipherAlgorithm = 'chacha20-poly1305' | 'aes-256-gcm';

export type Sv2NoiseDhMode = 'ellswift' | 'x25519';

export type Sv2NoiseHashAlgorithm = 'sha256' | 'blake2s256';

export interface Sv2X25519Keypair {
  privateKey: Buffer; // 32-byte X25519 private key
  publicKey: Buffer;  // 32-byte X25519 public key
}

export function generateX25519Keypair(): Sv2X25519Keypair {
  const kp = crypto.generateKeyPairSync('x25519');
  const pubJwk = kp.publicKey.export({ format: 'jwk' });
  const privJwk = kp.privateKey.export({ format: 'jwk' });
  return {
    publicKey: Buffer.from(pubJwk.x!, 'base64url'),
    privateKey: Buffer.from(privJwk.d!, 'base64url'),
  };
}

function x25519Ecdh(ourPrivRaw: Buffer, ourPubRaw: Buffer, theirPubRaw: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: {
      crv: 'X25519',
      d: ourPrivRaw.toString('base64url'),
      x: ourPubRaw.toString('base64url'),
      kty: 'OKP',
    },
    format: 'jwk',
  });
  const pubKey = crypto.createPublicKey({
    key: {
      crv: 'X25519',
      x: theirPubRaw.toString('base64url'),
      kty: 'OKP',
    },
    format: 'jwk',
  });
  return crypto.diffieHellman({ publicKey: pubKey, privateKey: privKey });
}

// ── Ed25519 Helpers (BraiinsOS certificate signing) ──────────────

export interface Sv2Ed25519Keypair {
  privateKeyRaw: Buffer; // 32-byte Ed25519 seed
  publicKeyRaw: Buffer;  // 32-byte Ed25519 public key
}

export function generateEd25519Keypair(): Sv2Ed25519Keypair {
  const kp = crypto.generateKeyPairSync('ed25519');
  const pubJwk = kp.publicKey.export({ format: 'jwk' });
  const privJwk = kp.privateKey.export({ format: 'jwk' });
  return {
    publicKeyRaw: Buffer.from(pubJwk.x!, 'base64url'),
    privateKeyRaw: Buffer.from(privJwk.d!, 'base64url'),
  };
}

function ed25519PrivateKeyObject(seed: Buffer, pub: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: { crv: 'Ed25519', d: seed.toString('base64url'), x: pub.toString('base64url'), kty: 'OKP' },
    format: 'jwk',
  });
}

function ed25519PublicKeyObject(pub: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { crv: 'Ed25519', x: pub.toString('base64url'), kty: 'OKP' },
    format: 'jwk',
  });
}

/**
 * Encode an Ed25519 public key in BraiinsOS base58check format.
 * Format: base58check(32-byte pubkey + 4-byte SHA256d checksum) — no version prefix.
 * This is the format used in BraiinsOS pool URLs:
 *   stratum2+tcp://pool.example.com:3336/ENCODED_KEY_HERE
 */
export function encodeEd25519PubKeyBase58Check(pubKeyRaw: Buffer): string {
  const checksum = sha256(sha256(pubKeyRaw)).subarray(0, 4);
  return base58Encode(Buffer.concat([pubKeyRaw, checksum]));
}

// Minimal base58 encoder (Bitcoin alphabet)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Buffer): string {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zeros
  let result = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result += BASE58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function getNoiseProtocolName(dhMode: Sv2NoiseDhMode, cipher: Sv2CipherAlgorithm): string {
  // Allow overriding protocol name via env var for debugging BraiinsOS compatibility
  const override = process.env.SV2_X25519_PROTOCOL_NAME;
  if (dhMode === 'x25519' && override) {
    return override;
  }
  if (dhMode === 'x25519') {
    // BraiinsOS legacy firmware uses Noise_NX_25519_AESGCM_BLAKE2s
    return SV2_NOISE_PROTOCOL_NAME_X25519_AESGCM_BLAKE2S;
  }
  return cipher === 'aes-256-gcm'
    ? SV2_NOISE_PROTOCOL_NAME_AESGCM
    : SV2_NOISE_PROTOCOL_NAME;
}

/**
 * Determine the hash algorithm from the Noise protocol name.
 * Protocol names ending in _BLAKE2s use BLAKE2s; otherwise SHA-256.
 */
function getHashAlgorithm(protocolName: string): Sv2NoiseHashAlgorithm {
  if (protocolName.endsWith('BLAKE2s')) {
    return 'blake2s256';
  }
  return 'sha256';
}

// ── EllSwift Loader (ESM dynamic import) ────────────────────────────

interface EllSwiftApi {
  keygen(): { privateKey: Uint8Array; publicKey: Uint8Array };
  getSharedSecret(privKey: Uint8Array, pubKey: Uint8Array): Uint8Array;
  getSharedSecretBip324(
    privateKeyOurs: Uint8Array,
    publicKeyTheirs: Uint8Array,
    publicKeyOurs: Uint8Array,
    initiating: boolean,
  ): Uint8Array;
}

let ellSwiftCache: EllSwiftApi | null = null;

export async function loadEllSwift(): Promise<EllSwiftApi> {
  if (ellSwiftCache) return ellSwiftCache;
  let mod: any;
  try {
    // Works in Jest (ts-jest transforms ESM to CJS) and bundled environments
    mod = require('@scure/btc-signer/p2p.js');
  } catch {
    // Runtime fallback: dynamic import for ESM-only packages in Node CJS mode
    const importFn = new Function('specifier', 'return import(specifier)');
    mod = await importFn('@scure/btc-signer/p2p.js');
  }
  ellSwiftCache = mod.elligatorSwift as EllSwiftApi;
  return ellSwiftCache;
}

// ── Crypto Primitives ───────────────────────────────────────────────

export function hmacHash(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * SV2 HKDF with 2 outputs (not RFC 5869).
 * temp_key = HMAC(chaining_key, input_key_material)
 * output1 = HMAC(temp_key, 0x01)
 * output2 = HMAC(temp_key, output1 || 0x02)
 */
export function hkdf2(chainingKey: Buffer, ikm: Buffer): [Buffer, Buffer] {
  return noiseHkdf2(chainingKey, ikm, 'sha256');
}

// ── Parameterized Hash Primitives (for BLAKE2s support) ──────────

function noiseHash(data: Buffer, algo: Sv2NoiseHashAlgorithm): Buffer {
  return crypto.createHash(algo).update(data).digest();
}

function noiseHmac(key: Buffer, data: Buffer, algo: Sv2NoiseHashAlgorithm): Buffer {
  return crypto.createHmac(algo, key).update(data).digest();
}

function noiseHkdf2(chainingKey: Buffer, ikm: Buffer, algo: Sv2NoiseHashAlgorithm): [Buffer, Buffer] {
  const tempKey = noiseHmac(chainingKey, ikm, algo);
  const out1 = noiseHmac(tempKey, Buffer.from([0x01]), algo);
  const out2 = noiseHmac(tempKey, Buffer.concat([out1, Buffer.from([0x02])]), algo);
  return [out1, out2];
}

// ── CipherState ─────────────────────────────────────────────────────

/**
 * Nonce encoding per Noise spec:
 * - ChaCha20-Poly1305 (Section 12.3): 4 zero bytes + LE64(n)
 * - AES-256-GCM (Section 12.4): 4 zero bytes + BE64(n)
 *
 * Set SV2_NONCE_LE=true to force LE for all ciphers (matches SRI Rust behavior).
 */
function encodeNonce(n: bigint, algorithm: Sv2CipherAlgorithm): Buffer {
  const buf = Buffer.alloc(12);
  if (algorithm === 'aes-256-gcm' && process.env.SV2_NONCE_LE !== 'true') {
    buf.writeBigUInt64BE(n, 4);
  } else {
    buf.writeBigUInt64LE(n, 4);
  }
  return buf;
}

export class Sv2CipherState {
  private k: Buffer | null = null;
  private n = 0n;
  private readonly algorithm: Sv2CipherAlgorithm;

  constructor(algorithm: Sv2CipherAlgorithm = 'chacha20-poly1305') {
    this.algorithm = algorithm;
  }

  get hasKey(): boolean {
    return this.k !== null;
  }

  initializeKey(key: Buffer): void {
    if (key.length !== 32) throw new Error('CipherState key must be 32 bytes');
    this.k = key;
    this.n = 0n;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return plaintext;
    const nonce = encodeNonce(this.n, this.algorithm);
    const cipher = crypto.createCipheriv(this.algorithm, this.k, nonce, {
      authTagLength: SV2_MAC_SIZE,
    } as any) as crypto.CipherGCM;
    if (this.algorithm === 'aes-256-gcm') {
      cipher.setAAD(ad, { plaintextLength: plaintext.length } as any);
    } else {
      cipher.setAAD(ad, {} as any);
    }
    const encrypted = cipher.update(plaintext);
    cipher.final();
    const tag = cipher.getAuthTag();
    this.n++;
    return Buffer.concat([encrypted, tag]);
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.k) return ciphertext;
    if (ciphertext.length < SV2_MAC_SIZE) {
      throw new Error('Ciphertext too short for MAC');
    }
    const nonce = encodeNonce(this.n, this.algorithm);
    const encData = ciphertext.subarray(0, ciphertext.length - SV2_MAC_SIZE);
    const tag = ciphertext.subarray(ciphertext.length - SV2_MAC_SIZE);
    const decipher = crypto.createDecipheriv(this.algorithm, this.k, nonce, {
      authTagLength: SV2_MAC_SIZE,
    } as any) as crypto.DecipherGCM;
    if (this.algorithm === 'aes-256-gcm') {
      decipher.setAAD(ad, { plaintextLength: encData.length } as any);
    } else {
      decipher.setAAD(ad, {} as any);
    }
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(encData);
    decipher.final();
    this.n++;
    return Buffer.from(decrypted);
  }
}

// ── Certificate / Signature Noise Message ───────────────────────────

export interface Sv2SignatureNoiseMessage {
  version: number; // U16
  validFrom: number; // U32 (unix timestamp)
  notValidAfter: number; // U32 (unix timestamp)
  signature: Buffer; // 64-byte Schnorr signature
}

/**
 * Serialize a SignatureNoiseMessage to 74 bytes.
 */
export function serializeSignatureNoiseMessage(msg: Sv2SignatureNoiseMessage): Buffer {
  const buf = Buffer.alloc(SV2_SIGNATURE_NOISE_MSG_SIZE);
  buf.writeUInt16LE(msg.version, 0);
  buf.writeUInt32LE(msg.validFrom, 2);
  buf.writeUInt32LE(msg.notValidAfter, 6);
  msg.signature.copy(buf, 10);
  return buf;
}

/**
 * Deserialize a 74-byte SignatureNoiseMessage.
 */
export function deserializeSignatureNoiseMessage(buf: Buffer): Sv2SignatureNoiseMessage {
  if (buf.length < SV2_SIGNATURE_NOISE_MSG_SIZE) {
    throw new Error(`SignatureNoiseMessage requires ${SV2_SIGNATURE_NOISE_MSG_SIZE} bytes`);
  }
  return {
    version: buf.readUInt16LE(0),
    validFrom: buf.readUInt32LE(2),
    notValidAfter: buf.readUInt32LE(6),
    signature: Buffer.from(buf.subarray(10, 74)),
  };
}

/**
 * Create a SignatureNoiseMessage that certifies a static key.
 * Signs: version || validFrom || notValidAfter || staticPubKey (x-only, 32 bytes)
 * using the authority's private key (BIP-340 Schnorr).
 */
export function createSignatureNoiseMessage(
  authorityPrivKey: Buffer,
  staticPubKeyXOnly: Buffer,
  validFrom: number,
  notValidAfter: number,
): Sv2SignatureNoiseMessage {
  const version = 0;
  const msgBuf = Buffer.alloc(2 + 4 + 4 + 32);
  msgBuf.writeUInt16LE(version, 0);
  msgBuf.writeUInt32LE(validFrom, 2);
  msgBuf.writeUInt32LE(notValidAfter, 6);
  staticPubKeyXOnly.copy(msgBuf, 10);

  const msgHash = sha256(msgBuf);
  const sig = ecc.signSchnorr(msgHash, authorityPrivKey);
  if (!sig) throw new Error('Schnorr signing failed');

  return {
    version,
    validFrom,
    notValidAfter,
    signature: Buffer.from(sig),
  };
}

// ── BraiinsOS Certificate Format (76 bytes, Ed25519) ────────────────

/**
 * Serialize a SignatureNoiseMessage to BraiinsOS format (76 bytes).
 * Format: version(U16) + validFrom(U32) + notValidAfter(U32) + sig_len(U16) + signature(64)
 * The sig_len field is the V2 serializer's Bytes/Vec<u8> length prefix.
 */
export function serializeSignatureNoiseMessageBraiins(msg: Sv2SignatureNoiseMessage): Buffer {
  const buf = Buffer.alloc(SV2_SIGNATURE_NOISE_MSG_SIZE_BRAIINS);
  buf.writeUInt16LE(msg.version, 0);
  buf.writeUInt32LE(msg.validFrom, 2);
  buf.writeUInt32LE(msg.notValidAfter, 6);
  buf.writeUInt16LE(msg.signature.length, 10); // U16 LE length prefix (64 = 0x40, 0x00)
  msg.signature.copy(buf, 12);
  return buf;
}

/**
 * Deserialize a 76-byte BraiinsOS SignatureNoiseMessage.
 */
export function deserializeSignatureNoiseMessageBraiins(buf: Buffer): Sv2SignatureNoiseMessage {
  if (buf.length < SV2_SIGNATURE_NOISE_MSG_SIZE_BRAIINS) {
    throw new Error(`BraiinsOS SignatureNoiseMessage requires ${SV2_SIGNATURE_NOISE_MSG_SIZE_BRAIINS} bytes, got ${buf.length}`);
  }
  const sigLen = buf.readUInt16LE(10);
  return {
    version: buf.readUInt16LE(0),
    validFrom: buf.readUInt32LE(2),
    notValidAfter: buf.readUInt32LE(6),
    signature: Buffer.from(buf.subarray(12, 12 + sigLen)),
  };
}

/**
 * Create a SignatureNoiseMessage using Ed25519 (BraiinsOS format).
 * SignedPart: version(U16) + validFrom(U32) + notValidAfter(U32)
 *   + U16_LE(pubkey.length) + noise_static_pubkey + authority_ed25519_pubkey(32)
 * The signature is Ed25519 over the raw SignedPart bytes (no pre-hashing).
 */
/**
 * Build the Ed25519 signed part bytes for BraiinsOS certificate signing/verification.
 * The format is configurable via SV2_CERT_SIGNED_PART env var to handle firmware variations:
 *   "78" (default) — header(10) + U16(32) + static_key(32) + U16(32) + authority_key(32)
 *   "74"           — header(10) + static_key(32) + authority_key(32) (no length prefixes)
 *   "42"           — header(10) + static_key(32) (no authority key, no prefixes)
 */
export function buildEd25519SignedPart(
  version: number,
  validFrom: number,
  notValidAfter: number,
  staticPubKey: Buffer,
  authorityPubKey: Buffer,
): Buffer {
  const format = process.env.SV2_CERT_SIGNED_PART ?? '78';

  let signedPart: Buffer;
  let offset = 0;

  if (format === '42') {
    // header(10) + static_key(32) = 42 bytes (no authority key, no length prefixes)
    signedPart = Buffer.alloc(42);
    signedPart.writeUInt16LE(version, offset); offset += 2;
    signedPart.writeUInt32LE(validFrom, offset); offset += 4;
    signedPart.writeUInt32LE(notValidAfter, offset); offset += 4;
    staticPubKey.copy(signedPart, offset);
  } else if (format === '74') {
    // header(10) + static_key(32) + authority_key(32) = 74 bytes (no length prefixes)
    signedPart = Buffer.alloc(74);
    signedPart.writeUInt16LE(version, offset); offset += 2;
    signedPart.writeUInt32LE(validFrom, offset); offset += 4;
    signedPart.writeUInt32LE(notValidAfter, offset); offset += 4;
    staticPubKey.copy(signedPart, offset); offset += staticPubKey.length;
    authorityPubKey.copy(signedPart, offset);
  } else {
    // "78" (default): header(10) + U16(32) + static_key(32) + U16(32) + authority_key(32)
    signedPart = Buffer.alloc(78);
    signedPart.writeUInt16LE(version, offset); offset += 2;
    signedPart.writeUInt32LE(validFrom, offset); offset += 4;
    signedPart.writeUInt32LE(notValidAfter, offset); offset += 4;
    signedPart.writeUInt16LE(staticPubKey.length, offset); offset += 2;
    staticPubKey.copy(signedPart, offset); offset += staticPubKey.length;
    signedPart.writeUInt16LE(authorityPubKey.length, offset); offset += 2;
    authorityPubKey.copy(signedPart, offset);
  }

  return signedPart;
}

export function createSignatureNoiseMessageEd25519(
  authorityKeypair: Sv2Ed25519Keypair,
  staticPubKey: Buffer,
  validFrom: number,
  notValidAfter: number,
): Sv2SignatureNoiseMessage {
  const version = 0;

  const signedPart = buildEd25519SignedPart(
    version, validFrom, notValidAfter,
    staticPubKey, authorityKeypair.publicKeyRaw,
  );

  // Ed25519 sign (no pre-hashing, Ed25519 handles its own hashing internally)
  const privKeyObj = ed25519PrivateKeyObject(authorityKeypair.privateKeyRaw, authorityKeypair.publicKeyRaw);
  const signature = crypto.sign(null, signedPart, privKeyObj);

  const format = process.env.SV2_CERT_SIGNED_PART ?? '78';
  if (process.env.SV2_NOISE_DEBUG === 'true') {
    console.log(`[Ed25519] Cert signed with format=${format} (${signedPart.length} bytes), sig=${Buffer.from(signature).subarray(0, 8).toString('hex')}...`);
  }

  return {
    version,
    validFrom,
    notValidAfter,
    signature: Buffer.from(signature),
  };
}

/**
 * Validate a BraiinsOS Ed25519 SignatureNoiseMessage against an authority public key.
 */
export function validateSignatureNoiseMessageEd25519(
  msg: Sv2SignatureNoiseMessage,
  authorityPubKeyRaw: Buffer,
  staticPubKey: Buffer,
): boolean {
  const signedPart = buildEd25519SignedPart(
    msg.version, msg.validFrom, msg.notValidAfter,
    staticPubKey, authorityPubKeyRaw,
  );
  const pubKeyObj = ed25519PublicKeyObject(authorityPubKeyRaw);
  return crypto.verify(null, signedPart, pubKeyObj, msg.signature);
}

/**
 * Validate a SignatureNoiseMessage against an authority public key.
 */
export function validateSignatureNoiseMessage(
  msg: Sv2SignatureNoiseMessage,
  authorityPubKeyXOnly: Buffer,
  staticPubKeyXOnly: Buffer,
): boolean {
  const msgBuf = Buffer.alloc(2 + 4 + 4 + 32);
  msgBuf.writeUInt16LE(msg.version, 0);
  msgBuf.writeUInt32LE(msg.validFrom, 2);
  msgBuf.writeUInt32LE(msg.notValidAfter, 6);
  staticPubKeyXOnly.copy(msgBuf, 10);

  const msgHash = sha256(msgBuf);
  return ecc.verifySchnorr(msgHash, authorityPubKeyXOnly, msg.signature);
}

// ── Server Keypair Generation ───────────────────────────────────────

export interface Sv2ServerKeypair {
  privateKey: Buffer; // 32-byte secret scalar
  publicKey: Buffer; // 64-byte EllSwift-encoded public key
}

export async function generateServerKeypair(): Promise<Sv2ServerKeypair> {
  const es = await loadEllSwift();
  const kp = es.keygen();
  return {
    privateKey: Buffer.from(kp.privateKey),
    publicKey: Buffer.from(kp.publicKey),
  };
}

/**
 * Get the x-only (32-byte) public key from a 32-byte private key.
 */
export function xOnlyPubKeyFromPriv(privKey: Buffer): Buffer {
  const xOnly = ecc.xOnlyPointFromScalar(privKey);
  if (!xOnly) throw new Error('Failed to derive x-only public key');
  return Buffer.from(xOnly);
}

// ── Noise NX Session (Responder / Server side) ──────────────────────

export interface Sv2NoiseConfig {
  /** Server's static keypair (EllSwift). */
  staticKeypair: Sv2ServerKeypair;
  /** Pre-computed certificate message (signed by authority). */
  certificateMessage: Sv2SignatureNoiseMessage;
  /** X25519 static keypair (32-byte keys) for BraiinsOS mode. */
  x25519StaticKeypair?: Sv2X25519Keypair;
  /** Certificate for the X25519 static key. */
  x25519CertificateMessage?: Sv2SignatureNoiseMessage;
}

export class Sv2NoiseSession {
  private h: Buffer; // handshake hash
  private ck: Buffer; // chaining key
  private tempCipher: Sv2CipherState;
  private sendCipher: Sv2CipherState;
  private recvCipher: Sv2CipherState;
  private handshakeComplete = false;
  private ellSwift!: EllSwiftApi;
  private readonly cipherAlgorithm: Sv2CipherAlgorithm;
  private readonly handshakeCipherAlgorithm: Sv2CipherAlgorithm;
  private readonly dhMode: Sv2NoiseDhMode;
  private readonly hashAlgorithm: Sv2NoiseHashAlgorithm;

  private serverEphemeralPriv!: Buffer;
  private serverEphemeralPub!: Buffer;

  constructor(
    private readonly config: Sv2NoiseConfig,
    cipherAlgorithm: Sv2CipherAlgorithm = 'chacha20-poly1305',
    dhMode: Sv2NoiseDhMode = 'ellswift',
    prologue: Buffer = Buffer.alloc(0),
    handshakeCipherOverride?: Sv2CipherAlgorithm,
  ) {
    this.cipherAlgorithm = cipherAlgorithm;
    this.dhMode = dhMode;

    const protocolNameStr = getNoiseProtocolName(dhMode, cipherAlgorithm);
    this.hashAlgorithm = getHashAlgorithm(protocolNameStr);

    // For X25519+BLAKE2s (BraiinsOS): both handshake and transport use AES-GCM
    // Can be overridden via handshakeCipherOverride parameter
    this.handshakeCipherAlgorithm = handshakeCipherOverride
      ?? (dhMode === 'x25519' ? 'aes-256-gcm' : cipherAlgorithm);
    this.tempCipher = new Sv2CipherState(this.handshakeCipherAlgorithm);
    this.sendCipher = new Sv2CipherState(cipherAlgorithm);
    this.recvCipher = new Sv2CipherState(cipherAlgorithm);

    // Initialize h = HASH(protocol_name) if len > 32, else pad
    const protocolName = Buffer.from(protocolNameStr, 'ascii');
    if (protocolName.length <= 32) {
      this.h = Buffer.alloc(32);
      protocolName.copy(this.h);
    } else {
      this.h = noiseHash(protocolName, this.hashAlgorithm);
    }
    // ck = h
    this.ck = Buffer.from(this.h);
    // MixHash(prologue) per Noise spec: h = HASH(h || prologue)
    this.h = noiseHash(Buffer.concat([this.h, prologue]), this.hashAlgorithm);
  }

  // ── Noise Symmetric State Helpers ─────────────────────────────────

  private mixHash(data: Buffer): void {
    this.h = noiseHash(Buffer.concat([this.h, data]), this.hashAlgorithm);
  }

  private mixKey(ikm: Buffer): void {
    const [newCk, tempK] = noiseHkdf2(this.ck, ikm, this.hashAlgorithm);
    this.ck = newCk;
    this.tempCipher = new Sv2CipherState(this.handshakeCipherAlgorithm);
    this.tempCipher.initializeKey(tempK);
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.tempCipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.tempCipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  // ── ECDH via EllSwift ─────────────────────────────────────────────

  /**
   * Compute BIP-324 EllSwift ECDH.
   * Rust secp256k1's ElligatorSwift::shared_secret uses BIP-324 by default.
   * @param localPriv - Our private key (32 bytes)
   * @param localPub - Our EllSwift public key (64 bytes)
   * @param remotePub - Their EllSwift public key (64 bytes)
   * @param weAreInitiator - Party bit: true for initiator, false for responder
   */
  /**
   * Compute BIP-324 EllSwift ECDH.
   */
  private ecdh(localPriv: Buffer, localPub: Buffer, remotePub: Buffer, weAreInitiator: boolean): Buffer {
    const secret = this.ellSwift.getSharedSecretBip324(
      new Uint8Array(localPriv),
      new Uint8Array(remotePub),
      new Uint8Array(localPub),
      weAreInitiator,
    );
    return Buffer.from(secret);
  }

  // ── Handshake: Process Act 1, Generate Act 2 ─────────────────────

  /**
   * Process the initiator's Act 1 ephemeral key and produce Act 2.
   * EllSwift mode: 64-byte Act 1 → 234-byte Act 2
   * X25519 mode: 32-byte Act 1 → 172-byte Act 2 (BraiinsOS 76-byte cert)
   */
  async processAct1(act1: Buffer): Promise<Buffer> {
    if (this.dhMode === 'x25519') {
      return this.processAct1X25519(act1);
    }
    return this.processAct1EllSwift(act1);
  }

  private async processAct1EllSwift(act1: Buffer): Promise<Buffer> {
    if (act1.length !== SV2_ELLSWIFT_KEY_SIZE) {
      throw new Error(`Act 1 must be ${SV2_ELLSWIFT_KEY_SIZE} bytes, got ${act1.length}`);
    }

    const debug = process.env.SV2_NOISE_DEBUG === 'true';

    if (debug) {
      const protocolNameStr = getNoiseProtocolName('ellswift', this.cipherAlgorithm);
      console.log(`[NOISE-ELLSWIFT] Protocol name: "${protocolNameStr}" (${protocolNameStr.length} bytes)`);
      console.log(`[NOISE-ELLSWIFT] Hash: ${this.hashAlgorithm}, Handshake cipher: ${this.handshakeCipherAlgorithm}, Transport cipher: ${this.cipherAlgorithm}`);
      console.log(`[NOISE-ELLSWIFT] Init ck=${this.ck.toString('hex')}`);
      console.log(`[NOISE-ELLSWIFT] Init h=${this.h.toString('hex')}`);
    }

    this.ellSwift = await loadEllSwift();

    const remoteEphemeral = act1;
    this.mixHash(remoteEphemeral);
    if (debug) console.log(`[NOISE-ELLSWIFT] After MixHash(re): h=${this.h.toString('hex')}`);

    this.decryptAndHash(Buffer.alloc(0));
    if (debug) console.log(`[NOISE-ELLSWIFT] After DecryptAndHash(empty): h=${this.h.toString('hex')}`);

    const serverEph = this.ellSwift.keygen();
    this.serverEphemeralPriv = Buffer.from(serverEph.privateKey);
    this.serverEphemeralPub = Buffer.from(serverEph.publicKey);

    if (debug) console.log(`[NOISE-ELLSWIFT] Server eph pub: ${this.serverEphemeralPub.toString('hex')}`);

    this.mixHash(this.serverEphemeralPub);
    if (debug) console.log(`[NOISE-ELLSWIFT] After MixHash(se): h=${this.h.toString('hex')}`);

    const eeDH = this.ecdh(
      this.serverEphemeralPriv,
      this.serverEphemeralPub,
      remoteEphemeral,
      false,
    );
    if (debug) console.log(`[NOISE-ELLSWIFT] ee DH shared secret: ${eeDH.toString('hex')}`);

    this.mixKey(eeDH);
    if (debug) console.log(`[NOISE-ELLSWIFT] After MixKey(ee): ck=${this.ck.toString('hex')}`);

    const staticPubKey = this.config.staticKeypair.publicKey;
    if (debug) {
      console.log(`[NOISE-ELLSWIFT] h (AD for encrypt static): ${this.h.toString('hex')}`);
      console.log(`[NOISE-ELLSWIFT] Static pub (plaintext): ${staticPubKey.toString('hex')}`);
    }

    const encryptedStatic = this.encryptAndHash(staticPubKey);
    if (debug) console.log(`[NOISE-ELLSWIFT] Encrypted static (${encryptedStatic.length} bytes): ${encryptedStatic.toString('hex')}`);

    const esDH = this.ecdh(
      this.config.staticKeypair.privateKey,
      this.config.staticKeypair.publicKey,
      remoteEphemeral,
      false,
    );
    if (debug) console.log(`[NOISE-ELLSWIFT] es DH shared secret: ${esDH.toString('hex')}`);

    this.mixKey(esDH);
    if (debug) console.log(`[NOISE-ELLSWIFT] After MixKey(es): ck=${this.ck.toString('hex')}`);

    const certPayload = serializeSignatureNoiseMessage(this.config.certificateMessage);
    if (debug) console.log(`[NOISE-ELLSWIFT] h (AD for encrypt cert): ${this.h.toString('hex')}`);
    if (debug) console.log(`[NOISE-ELLSWIFT] Cert payload (${certPayload.length} bytes): ${certPayload.toString('hex')}`);

    const encryptedCert = this.encryptAndHash(certPayload);
    if (debug) console.log(`[NOISE-ELLSWIFT] Encrypted cert (${encryptedCert.length} bytes)`);

    const [k1, k2] = noiseHkdf2(this.ck, Buffer.alloc(0), this.hashAlgorithm);
    this.recvCipher.initializeKey(k1);
    this.sendCipher.initializeKey(k2);
    this.handshakeComplete = true;

    const act2 = Buffer.concat([this.serverEphemeralPub, encryptedStatic, encryptedCert]);
    if (debug) console.log(`[NOISE-ELLSWIFT] Act 2 total: ${act2.length} bytes`);

    return act2;
  }

  private async processAct1X25519(act1: Buffer): Promise<Buffer> {
    if (act1.length !== SV2_X25519_KEY_SIZE) {
      throw new Error(`Act 1 (X25519) must be ${SV2_X25519_KEY_SIZE} bytes, got ${act1.length}`);
    }
    if (!this.config.x25519StaticKeypair || !this.config.x25519CertificateMessage) {
      throw new Error('X25519 static keypair and certificate required for X25519 DH mode');
    }

    const debug = process.env.SV2_NOISE_DEBUG === 'true';

    const remoteEphemeral = act1;
    if (debug) {
      const protocolNameStr = getNoiseProtocolName(this.dhMode, this.cipherAlgorithm);
      console.log(`[NOISE-X25519] Protocol name: "${protocolNameStr}" (${protocolNameStr.length} bytes)`);
      console.log(`[NOISE-X25519] Hash: ${this.hashAlgorithm}, Handshake cipher: ${this.handshakeCipherAlgorithm}, Transport cipher: ${this.cipherAlgorithm}`);
      console.log(`[NOISE-X25519] Init ck=${this.ck.toString('hex')}`);
      console.log(`[NOISE-X25519] Init h=${this.h.toString('hex')}`);
    }
    this.mixHash(remoteEphemeral);
    if (debug) console.log(`[NOISE-X25519] After MixHash(re): h=${this.h.toString('hex')}`);
    this.decryptAndHash(Buffer.alloc(0));
    if (debug) console.log(`[NOISE-X25519] After DecryptAndHash(empty): h=${this.h.toString('hex')}`);

    // Generate X25519 ephemeral keypair
    const serverEph = generateX25519Keypair();
    this.serverEphemeralPriv = serverEph.privateKey;
    this.serverEphemeralPub = serverEph.publicKey;

    if (debug) console.log(`[NOISE-X25519] Server eph pub: ${this.serverEphemeralPub.toString('hex')}`);
    this.mixHash(this.serverEphemeralPub);
    if (debug) console.log(`[NOISE-X25519] After MixHash(se): h=${this.h.toString('hex')}`);

    // ee DH: X25519 is symmetric, no party bit
    const eeDH = x25519Ecdh(this.serverEphemeralPriv, this.serverEphemeralPub, remoteEphemeral);
    if (debug) console.log(`[NOISE-X25519] ee DH shared secret: ${eeDH.toString('hex')}`);
    this.mixKey(eeDH);
    if (debug) console.log(`[NOISE-X25519] After MixKey(ee): ck=${this.ck.toString('hex')}`);

    // EncryptAndHash(static pubkey) — 32 bytes for X25519
    const staticPubKey = this.config.x25519StaticKeypair.publicKey;
    if (debug) {
      console.log(`[NOISE-X25519] h (AD for encrypt static): ${this.h.toString('hex')}`);
      console.log(`[NOISE-X25519] Static pub (plaintext): ${staticPubKey.toString('hex')}`);
    }
    const encryptedStatic = this.encryptAndHash(staticPubKey); // 32 + 16 = 48 bytes
    if (debug) console.log(`[NOISE-X25519] Encrypted static (${encryptedStatic.length} bytes): ${encryptedStatic.toString('hex')}`);

    // es DH
    const esDH = x25519Ecdh(
      this.config.x25519StaticKeypair.privateKey,
      this.config.x25519StaticKeypair.publicKey,
      remoteEphemeral,
    );
    if (debug) console.log(`[NOISE-X25519] es DH shared secret: ${esDH.toString('hex')}`);
    this.mixKey(esDH);
    if (debug) console.log(`[NOISE-X25519] After MixKey(es): ck=${this.ck.toString('hex')}`);

    // EncryptAndHash(certificate) — BraiinsOS 76-byte format with U16 sig_len prefix
    const certPayload = serializeSignatureNoiseMessageBraiins(this.config.x25519CertificateMessage);
    if (debug) console.log(`[NOISE-X25519] h (AD for encrypt cert): ${this.h.toString('hex')}`);
    if (debug) console.log(`[NOISE-X25519] Cert payload (${certPayload.length} bytes): ${certPayload.toString('hex')}`);
    const encryptedCert = this.encryptAndHash(certPayload); // 76 + 16 = 92 bytes
    if (debug) console.log(`[NOISE-X25519] Encrypted cert (${encryptedCert.length} bytes)`);

    const [k1, k2] = noiseHkdf2(this.ck, Buffer.alloc(0), this.hashAlgorithm);
    this.recvCipher.initializeKey(k1);
    this.sendCipher.initializeKey(k2);
    this.handshakeComplete = true;

    // Act 2 = server_eph(32) + enc_static(48) + enc_cert(92) = 172 bytes
    const act2 = Buffer.concat([this.serverEphemeralPub, encryptedStatic, encryptedCert]);
    if (debug) console.log(`[NOISE-X25519] Act 2 total: ${act2.length} bytes`);
    return act2;
  }

  // ── Post-Handshake Transport ──────────────────────────────────────

  encrypt(plaintext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.sendCipher.encryptWithAd(Buffer.alloc(0), plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.recvCipher.decryptWithAd(Buffer.alloc(0), ciphertext);
  }

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }
}

// ── Initiator Session (for testing) ─────────────────────────────────

export class Sv2NoiseInitiator {
  private h: Buffer;
  private ck: Buffer;
  private tempCipher: Sv2CipherState;
  private sendCipher: Sv2CipherState;
  private recvCipher: Sv2CipherState;
  private handshakeComplete = false;
  private ellSwift!: EllSwiftApi;
  private readonly cipherAlgorithm: Sv2CipherAlgorithm;
  private readonly handshakeCipherAlgorithm: Sv2CipherAlgorithm;
  private readonly dhMode: Sv2NoiseDhMode;
  private readonly hashAlgorithm: Sv2NoiseHashAlgorithm;

  private ephemeralPriv!: Buffer;
  private ephemeralPub!: Buffer;

  constructor(
    cipherAlgorithm: Sv2CipherAlgorithm = 'chacha20-poly1305',
    dhMode: Sv2NoiseDhMode = 'ellswift',
    prologue: Buffer = Buffer.alloc(0),
  ) {
    this.cipherAlgorithm = cipherAlgorithm;
    this.dhMode = dhMode;

    const protocolNameStr = getNoiseProtocolName(dhMode, cipherAlgorithm);
    this.hashAlgorithm = getHashAlgorithm(protocolNameStr);

    // For X25519+BLAKE2s (BraiinsOS): both handshake and transport use AES-GCM
    this.handshakeCipherAlgorithm = dhMode === 'x25519' ? 'aes-256-gcm' : cipherAlgorithm;
    this.tempCipher = new Sv2CipherState(this.handshakeCipherAlgorithm);
    this.sendCipher = new Sv2CipherState(cipherAlgorithm);
    this.recvCipher = new Sv2CipherState(cipherAlgorithm);

    const protocolName = Buffer.from(protocolNameStr, 'ascii');
    if (protocolName.length <= 32) {
      this.h = Buffer.alloc(32);
      protocolName.copy(this.h);
    } else {
      this.h = noiseHash(protocolName, this.hashAlgorithm);
    }
    this.ck = Buffer.from(this.h);
    // MixHash(prologue) per Noise spec: h = HASH(h || prologue)
    this.h = noiseHash(Buffer.concat([this.h, prologue]), this.hashAlgorithm);
  }

  private mixHash(data: Buffer): void {
    this.h = noiseHash(Buffer.concat([this.h, data]), this.hashAlgorithm);
  }

  private mixKey(ikm: Buffer): void {
    const [newCk, tempK] = noiseHkdf2(this.ck, ikm, this.hashAlgorithm);
    this.ck = newCk;
    this.tempCipher = new Sv2CipherState(this.handshakeCipherAlgorithm);
    this.tempCipher.initializeKey(tempK);
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.tempCipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  private ecdh(localPriv: Buffer, localPub: Buffer, remotePub: Buffer, weAreInitiator: boolean): Buffer {
    const secret = this.ellSwift.getSharedSecretBip324(
      new Uint8Array(localPriv),
      new Uint8Array(remotePub),
      new Uint8Array(localPub),
      weAreInitiator,
    );
    return Buffer.from(secret);
  }

  /** Generate Act 1: 64-byte (EllSwift) or 32-byte (X25519) ephemeral key. */
  async generateAct1(): Promise<Buffer> {
    if (this.dhMode === 'x25519') {
      const kp = generateX25519Keypair();
      this.ephemeralPriv = kp.privateKey;
      this.ephemeralPub = kp.publicKey;
    } else {
      this.ellSwift = await loadEllSwift();
      const kp = this.ellSwift.keygen();
      this.ephemeralPriv = Buffer.from(kp.privateKey);
      this.ephemeralPub = Buffer.from(kp.publicKey);
    }

    this.mixHash(this.ephemeralPub);
    this.mixHash(Buffer.alloc(0));
    return this.ephemeralPub;
  }

  /** Process Act 2 from responder, returns the decrypted server static key and cert. */
  processAct2(act2: Buffer): {
    serverStaticKey: Buffer;
    certificate: Sv2SignatureNoiseMessage;
  } {
    if (this.dhMode === 'x25519') {
      return this.processAct2X25519(act2);
    }
    return this.processAct2EllSwift(act2);
  }

  private processAct2EllSwift(act2: Buffer): {
    serverStaticKey: Buffer;
    certificate: Sv2SignatureNoiseMessage;
  } {
    if (act2.length !== 234) {
      throw new Error(`Act 2 must be 234 bytes, got ${act2.length}`);
    }

    const serverEphemeral = act2.subarray(0, 64);
    const encryptedStatic = act2.subarray(64, 144);
    const encryptedCert = act2.subarray(144, 234);

    this.mixHash(Buffer.from(serverEphemeral));

    const eeDH = this.ecdh(
      this.ephemeralPriv,
      this.ephemeralPub,
      Buffer.from(serverEphemeral),
      true,
    );
    this.mixKey(eeDH);

    const serverStaticKey = this.decryptAndHash(Buffer.from(encryptedStatic));

    const esDH = this.ecdh(
      this.ephemeralPriv,
      this.ephemeralPub,
      serverStaticKey,
      true,
    );
    this.mixKey(esDH);

    const certPayload = this.decryptAndHash(Buffer.from(encryptedCert));
    const certificate = deserializeSignatureNoiseMessage(certPayload);

    const [k1, k2] = noiseHkdf2(this.ck, Buffer.alloc(0), this.hashAlgorithm);
    this.sendCipher.initializeKey(k1);
    this.recvCipher.initializeKey(k2);
    this.handshakeComplete = true;

    return { serverStaticKey, certificate };
  }

  private processAct2X25519(act2: Buffer): {
    serverStaticKey: Buffer;
    certificate: Sv2SignatureNoiseMessage;
  } {
    // Act 2: server_eph(32) + enc_static(48) + enc_cert(92) = 172 bytes
    if (act2.length !== 172) {
      throw new Error(`Act 2 (X25519) must be 172 bytes, got ${act2.length}`);
    }

    const serverEphemeral = act2.subarray(0, 32);
    const encryptedStatic = act2.subarray(32, 80);  // 32 + 16 MAC = 48
    const encryptedCert = act2.subarray(80, 172);   // 76 + 16 MAC = 92

    this.mixHash(Buffer.from(serverEphemeral));

    // ee DH (X25519 — symmetric, no party bit)
    const eeDH = x25519Ecdh(this.ephemeralPriv, this.ephemeralPub, Buffer.from(serverEphemeral));
    this.mixKey(eeDH);

    // Decrypt static key (32 bytes)
    const serverStaticKey = this.decryptAndHash(Buffer.from(encryptedStatic));

    // es DH
    const esDH = x25519Ecdh(this.ephemeralPriv, this.ephemeralPub, serverStaticKey);
    this.mixKey(esDH);

    // Decrypt certificate (BraiinsOS 76-byte format with U16 sig_len prefix)
    const certPayload = this.decryptAndHash(Buffer.from(encryptedCert));
    const certificate = deserializeSignatureNoiseMessageBraiins(certPayload);

    const [k1, k2] = noiseHkdf2(this.ck, Buffer.alloc(0), this.hashAlgorithm);
    this.sendCipher.initializeKey(k1);
    this.recvCipher.initializeKey(k2);
    this.handshakeComplete = true;

    return { serverStaticKey, certificate };
  }

  encrypt(plaintext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.sendCipher.encryptWithAd(Buffer.alloc(0), plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.recvCipher.decryptWithAd(Buffer.alloc(0), ciphertext);
  }

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }
}
