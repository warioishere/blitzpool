import * as crypto from 'crypto';
import {
  hmacHash,
  sha256,
  hkdf2,
  Sv2CipherState,
  Sv2CipherAlgorithm,
  Sv2NoiseSession,
  Sv2NoiseInitiator,
  generateServerKeypair,
  generateX25519Keypair,
  generateEd25519Keypair,
  xOnlyPubKeyFromPriv,
  createSignatureNoiseMessage,
  createSignatureNoiseMessageEd25519,
  validateSignatureNoiseMessage,
  validateSignatureNoiseMessageEd25519,
  serializeSignatureNoiseMessage,
  deserializeSignatureNoiseMessage,
  serializeSignatureNoiseMessageBraiins,
  deserializeSignatureNoiseMessageBraiins,
  loadEllSwift,
} from './sv2-noise';
import { SV2_MAC_SIZE } from './sv2-constants';

describe('SV2 Noise', () => {
  // ── HMAC-SHA256 Test Vectors ──────────────────────────────────────

  describe('HMAC-SHA256', () => {
    it('should match known test vector (RFC 4231 test 1)', () => {
      const key = Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex');
      const data = Buffer.from('Hi There');
      const expected = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
      expect(hmacHash(key, data).toString('hex')).toBe(expected);
    });

    it('should match known test vector (RFC 4231 test 2)', () => {
      const key = Buffer.from('Jefe');
      const data = Buffer.from('what do ya want for nothing?');
      const expected = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
      expect(hmacHash(key, data).toString('hex')).toBe(expected);
    });
  });

  // ── HKDF2 ─────────────────────────────────────────────────────────

  describe('HKDF2', () => {
    it('should produce two 32-byte outputs', () => {
      const ck = Buffer.alloc(32, 0x01);
      const ikm = Buffer.alloc(32, 0x02);
      const [out1, out2] = hkdf2(ck, ikm);
      expect(out1.length).toBe(32);
      expect(out2.length).toBe(32);
      expect(out1.equals(out2)).toBe(false);
    });

    it('should be deterministic', () => {
      const ck = crypto.randomBytes(32);
      const ikm = crypto.randomBytes(32);
      const [a1, a2] = hkdf2(ck, ikm);
      const [b1, b2] = hkdf2(ck, ikm);
      expect(a1.equals(b1)).toBe(true);
      expect(a2.equals(b2)).toBe(true);
    });

    it('should work with empty IKM', () => {
      const ck = Buffer.alloc(32, 0xaa);
      const [out1, out2] = hkdf2(ck, Buffer.alloc(0));
      expect(out1.length).toBe(32);
      expect(out2.length).toBe(32);
    });
  });

  // ── CipherState ───────────────────────────────────────────────────

  describe('CipherState', () => {
    it('should encrypt and decrypt with matching keys', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      const plaintext = Buffer.from('test message for cipher state');
      const ciphertext = enc.encryptWithAd(ad, plaintext);

      expect(ciphertext.length).toBe(plaintext.length + SV2_MAC_SIZE);
      expect(ciphertext.subarray(0, plaintext.length).equals(plaintext)).toBe(false);

      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should fail decryption with wrong key', () => {
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(crypto.randomBytes(32));
      dec.initializeKey(crypto.randomBytes(32));

      const ct = enc.encryptWithAd(Buffer.alloc(0), Buffer.from('secret'));
      expect(() => dec.decryptWithAd(Buffer.alloc(0), ct)).toThrow();
    });

    it('should fail decryption with wrong AD', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ct = enc.encryptWithAd(Buffer.from('ad1'), Buffer.from('data'));
      expect(() => dec.decryptWithAd(Buffer.from('ad2'), ct)).toThrow();
    });

    it('should increment nonce (different ciphertext for same plaintext)', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      enc.initializeKey(key);

      const ad = Buffer.alloc(0);
      const pt = Buffer.from('same');
      const ct1 = enc.encryptWithAd(ad, pt);
      const ct2 = enc.encryptWithAd(ad, pt);
      expect(ct1.equals(ct2)).toBe(false);
    });

    it('should pass through plaintext when key is not set', () => {
      const cs = new Sv2CipherState();
      const ad = Buffer.alloc(0);
      const pt = Buffer.from('hello');
      expect(cs.encryptWithAd(ad, pt).equals(pt)).toBe(true);
      expect(cs.decryptWithAd(ad, pt).equals(pt)).toBe(true);
    });

    it('should track hasKey', () => {
      const cs = new Sv2CipherState();
      expect(cs.hasKey).toBe(false);
      cs.initializeKey(crypto.randomBytes(32));
      expect(cs.hasKey).toBe(true);
    });

    it('should reject non-32-byte keys', () => {
      const cs = new Sv2CipherState();
      expect(() => cs.initializeKey(Buffer.alloc(16))).toThrow();
    });

    it('should reject ciphertext shorter than MAC', () => {
      const cs = new Sv2CipherState();
      cs.initializeKey(crypto.randomBytes(32));
      expect(() => cs.decryptWithAd(Buffer.alloc(0), Buffer.alloc(10))).toThrow();
    });

    it('should handle multiple sequential encryptions and decryptions', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      for (let i = 0; i < 10; i++) {
        const pt = Buffer.from(`message ${i}`);
        const ct = enc.encryptWithAd(ad, pt);
        const result = dec.decryptWithAd(ad, ct);
        expect(result.toString()).toBe(`message ${i}`);
      }
    });
  });

  // ── Certificate / Signature ───────────────────────────────────────

  describe('Certificate', () => {
    it('should create and validate a signature noise message', () => {
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticPubKeyXOnly = crypto.randomBytes(32);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticPubKeyXOnly,
        now - 3600,
        now + 86400,
      );

      expect(cert.version).toBe(0);
      expect(cert.signature.length).toBe(64);
      expect(validateSignatureNoiseMessage(cert, authorityPubKey, staticPubKeyXOnly)).toBe(true);
    });

    it('should fail validation with wrong authority key', () => {
      const authorityPrivKey = crypto.randomBytes(32);
      const wrongPubKey = xOnlyPubKeyFromPriv(crypto.randomBytes(32));
      const staticPubKeyXOnly = crypto.randomBytes(32);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticPubKeyXOnly, now, now + 86400);

      expect(validateSignatureNoiseMessage(cert, wrongPubKey, staticPubKeyXOnly)).toBe(false);
    });

    it('should serialize and deserialize signature noise message', () => {
      const msg = {
        version: 0,
        validFrom: 1700000000,
        notValidAfter: 1700086400,
        signature: crypto.randomBytes(64),
      };
      const buf = serializeSignatureNoiseMessage(msg);
      expect(buf.length).toBe(74);
      const result = deserializeSignatureNoiseMessage(buf);
      expect(result.version).toBe(msg.version);
      expect(result.validFrom).toBe(msg.validFrom);
      expect(result.notValidAfter).toBe(msg.notValidAfter);
      expect(result.signature.equals(msg.signature)).toBe(true);
    });
  });

  // ── Key Generation ────────────────────────────────────────────────

  describe('Key Generation', () => {
    it('should generate server keypair with correct sizes', async () => {
      const kp = await generateServerKeypair();
      expect(kp.privateKey.length).toBe(32);
      expect(kp.publicKey.length).toBe(64);
    });

    it('should produce unique keypairs', async () => {
      const kp1 = await generateServerKeypair();
      const kp2 = await generateServerKeypair();
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
    });

    it('should derive x-only pubkey from privkey', () => {
      const privKey = crypto.randomBytes(32);
      const xOnly = xOnlyPubKeyFromPriv(privKey);
      expect(xOnly.length).toBe(32);
    });
  });

  // ── EllSwift Loader ───────────────────────────────────────────────

  describe('EllSwift Loader', () => {
    it('should load EllSwift API', async () => {
      const es = await loadEllSwift();
      expect(typeof es.keygen).toBe('function');
      expect(typeof es.getSharedSecret).toBe('function');
    });

    it('should cache the loaded module', async () => {
      const es1 = await loadEllSwift();
      const es2 = await loadEllSwift();
      expect(es1).toBe(es2);
    });
  });

  // ── Full Noise NX Handshake Self-Test ─────────────────────────────

  describe('Full Handshake', () => {
    it('should complete NX handshake and exchange encrypted messages', async () => {
      // 1. Generate server config
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticXOnly,
        now - 3600,
        now + 86400,
      );

      // 2. Create sessions
      const responder = new Sv2NoiseSession({
        staticKeypair: serverKeypair,
        certificateMessage: cert,
      });
      const initiator = new Sv2NoiseInitiator();

      // 3. Act 1: Initiator -> Responder (64 bytes)
      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(64);

      // 4. Act 2: Responder -> Initiator (234 bytes)
      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(234);

      // 5. Initiator processes Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(64);
      expect(certificate.version).toBe(0);

      // 6. Validate certificate
      expect(
        validateSignatureNoiseMessage(certificate, authorityPubKey, staticXOnly),
      ).toBe(true);

      // 7. Both sides should be ready
      expect(responder.isHandshakeComplete).toBe(true);
      expect(initiator.isHandshakeComplete).toBe(true);

      // 8. Exchange encrypted messages: initiator -> responder
      const msg1 = Buffer.from('hello from initiator');
      const enc1 = initiator.encrypt(msg1);
      expect(enc1.length).toBe(msg1.length + SV2_MAC_SIZE);
      const dec1 = responder.decrypt(enc1);
      expect(dec1.toString()).toBe('hello from initiator');

      // 9. Exchange encrypted messages: responder -> initiator
      const msg2 = Buffer.from('hello from responder');
      const enc2 = responder.encrypt(msg2);
      const dec2 = initiator.decrypt(enc2);
      expect(dec2.toString()).toBe('hello from responder');

      // 10. Multiple messages with nonce increment
      for (let i = 0; i < 5; i++) {
        const pt = Buffer.from(`bidirectional msg ${i}`);
        const ct = responder.encrypt(pt);
        expect(initiator.decrypt(ct).toString()).toBe(`bidirectional msg ${i}`);

        const pt2 = Buffer.from(`reply ${i}`);
        const ct2 = initiator.encrypt(pt2);
        expect(responder.decrypt(ct2).toString()).toBe(`reply ${i}`);
      }
    });

    it('should fail handshake with wrong Act 1 size', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticXOnly, now, now + 86400);

      const responder = new Sv2NoiseSession({
        staticKeypair: serverKeypair,
        certificateMessage: cert,
      });

      await expect(responder.processAct1(Buffer.alloc(32))).rejects.toThrow();
    });

    it('should not encrypt before handshake is complete', () => {
      const session = new Sv2NoiseInitiator();
      expect(() => session.encrypt(Buffer.from('test'))).toThrow('Handshake not complete');
      expect(() => session.decrypt(Buffer.alloc(32))).toThrow('Handshake not complete');
    });

    it('should complete NX handshake with AES-256-GCM and exchange encrypted messages', async () => {
      // 1. Generate server config
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticXOnly,
        now - 3600,
        now + 86400,
      );

      const cipher: Sv2CipherAlgorithm = 'aes-256-gcm';

      // 2. Create sessions with AES-GCM
      const responder = new Sv2NoiseSession(
        { staticKeypair: serverKeypair, certificateMessage: cert },
        cipher,
      );
      const initiator = new Sv2NoiseInitiator(cipher);

      // 3. Act 1: Initiator -> Responder (64 bytes)
      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(64);

      // 4. Act 2: Responder -> Initiator (234 bytes)
      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(234);

      // 5. Initiator processes Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(64);
      expect(certificate.version).toBe(0);

      // 6. Validate certificate
      expect(
        validateSignatureNoiseMessage(certificate, authorityPubKey, staticXOnly),
      ).toBe(true);

      // 7. Both sides should be ready
      expect(responder.isHandshakeComplete).toBe(true);
      expect(initiator.isHandshakeComplete).toBe(true);

      // 8. Exchange encrypted messages: initiator -> responder
      const msg1 = Buffer.from('hello from AES-GCM initiator');
      const enc1 = initiator.encrypt(msg1);
      expect(enc1.length).toBe(msg1.length + SV2_MAC_SIZE);
      const dec1 = responder.decrypt(enc1);
      expect(dec1.toString()).toBe('hello from AES-GCM initiator');

      // 9. Exchange encrypted messages: responder -> initiator
      const msg2 = Buffer.from('hello from AES-GCM responder');
      const enc2 = responder.encrypt(msg2);
      const dec2 = initiator.decrypt(enc2);
      expect(dec2.toString()).toBe('hello from AES-GCM responder');

      // 10. Multiple messages with nonce increment
      for (let i = 0; i < 5; i++) {
        const pt = Buffer.from(`AES-GCM bidirectional msg ${i}`);
        const ct = responder.encrypt(pt);
        expect(initiator.decrypt(ct).toString()).toBe(`AES-GCM bidirectional msg ${i}`);

        const pt2 = Buffer.from(`AES-GCM reply ${i}`);
        const ct2 = initiator.encrypt(pt2);
        expect(responder.decrypt(ct2).toString()).toBe(`AES-GCM reply ${i}`);
      }
    });

    it('should not cross-decrypt between ChaCha20 and AES-GCM sessions', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticXOnly, now, now + 86400);

      // ChaCha session
      const chachaResp = new Sv2NoiseSession(
        { staticKeypair: serverKeypair, certificateMessage: cert },
      );
      const chachaInit = new Sv2NoiseInitiator();
      const chachaAct1 = await chachaInit.generateAct1();
      const chachaAct2 = await chachaResp.processAct1(chachaAct1);
      chachaInit.processAct2(chachaAct2);

      // AES-GCM session (different keys, so ciphertexts are incompatible)
      const serverKeypair2 = await generateServerKeypair();
      const staticXOnly2 = xOnlyPubKeyFromPriv(serverKeypair2.privateKey);
      const cert2 = createSignatureNoiseMessage(authorityPrivKey, staticXOnly2, now, now + 86400);
      const aesResp = new Sv2NoiseSession(
        { staticKeypair: serverKeypair2, certificateMessage: cert2 },
        'aes-256-gcm',
      );
      const aesInit = new Sv2NoiseInitiator('aes-256-gcm');
      const aesAct1 = await aesInit.generateAct1();
      const aesAct2 = await aesResp.processAct1(aesAct1);
      aesInit.processAct2(aesAct2);

      // Encrypt with ChaCha, try to decrypt with AES-GCM -> should fail
      const ct = chachaInit.encrypt(Buffer.from('test'));
      expect(() => aesResp.decrypt(ct)).toThrow();
    });
  });

  // ── X25519 Key Generation ──────────────────────────────────────────

  describe('X25519 Key Generation', () => {
    it('should generate X25519 keypair with 32-byte keys', () => {
      const kp = generateX25519Keypair();
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    });

    it('should produce unique X25519 keypairs', () => {
      const kp1 = generateX25519Keypair();
      const kp2 = generateX25519Keypair();
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
    });
  });

  // ── Full X25519 + AES-GCM Handshake ───────────────────────────────

  describe('X25519+AES-GCM Handshake', () => {
    it('should complete NX handshake with X25519+AES-GCM and exchange encrypted messages', async () => {
      // Generate EllSwift keypair (still needed for config, but won't be used in X25519 path)
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();

      // Generate X25519 static keypair
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);

      // Create certificate for X25519 public key using Ed25519 (BraiinsOS format)
      const x25519Cert = createSignatureNoiseMessageEd25519(
        ed25519Authority,
        x25519Keypair.publicKey, // 32 bytes
        now - 3600,
        now + 86400,
      );

      // Also create EllSwift cert (needed for config completeness)
      const ellswiftCert = createSignatureNoiseMessage(
        authorityPrivKey,
        xOnlyPubKeyFromPriv(serverKeypair.privateKey),
        now - 3600,
        now + 86400,
      );

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      // Create sessions with X25519 DH + AES-GCM
      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519');
      const initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519');

      // Act 1: 32-byte X25519 ephemeral key
      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(32);

      // Act 2: 172 bytes (32 + 48 + 92) — BraiinsOS 76-byte cert + MAC
      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(172);

      // Initiator processes Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(32); // X25519 static key
      expect(certificate.version).toBe(0);

      // Validate certificate (Ed25519)
      expect(
        validateSignatureNoiseMessageEd25519(certificate, ed25519Authority.publicKeyRaw, x25519Keypair.publicKey),
      ).toBe(true);

      // Both sides should be ready
      expect(responder.isHandshakeComplete).toBe(true);
      expect(initiator.isHandshakeComplete).toBe(true);

      // Exchange encrypted messages: initiator -> responder
      const msg1 = Buffer.from('hello from X25519 initiator');
      const enc1 = initiator.encrypt(msg1);
      expect(enc1.length).toBe(msg1.length + SV2_MAC_SIZE);
      const dec1 = responder.decrypt(enc1);
      expect(dec1.toString()).toBe('hello from X25519 initiator');

      // Exchange encrypted messages: responder -> initiator
      const msg2 = Buffer.from('hello from X25519 responder');
      const enc2 = responder.encrypt(msg2);
      const dec2 = initiator.decrypt(enc2);
      expect(dec2.toString()).toBe('hello from X25519 responder');

      // Multiple messages with nonce increment
      for (let i = 0; i < 5; i++) {
        const pt = Buffer.from(`X25519 bidirectional msg ${i}`);
        const ct = responder.encrypt(pt);
        expect(initiator.decrypt(ct).toString()).toBe(`X25519 bidirectional msg ${i}`);

        const pt2 = Buffer.from(`X25519 reply ${i}`);
        const ct2 = initiator.encrypt(pt2);
        expect(responder.decrypt(ct2).toString()).toBe(`X25519 reply ${i}`);
      }
    });

    it('should fail X25519 handshake with wrong Act 1 size', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessageEd25519(ed25519Authority, x25519Keypair.publicKey, now, now + 86400);
      const ellswiftCert = createSignatureNoiseMessage(authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now, now + 86400);

      const responder = new Sv2NoiseSession(
        {
          staticKeypair: serverKeypair,
          certificateMessage: ellswiftCert,
          x25519StaticKeypair: x25519Keypair,
          x25519CertificateMessage: cert,
        },
        'aes-256-gcm',
        'x25519',
      );

      // 64 bytes is wrong for X25519 (expects 32)
      await expect(responder.processAct1(Buffer.alloc(64))).rejects.toThrow();
    });

    it('should complete X25519+AES-GCM handshake with prologue', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);
      const x25519Cert = createSignatureNoiseMessageEd25519(ed25519Authority, x25519Keypair.publicKey, now - 3600, now + 86400);
      const ellswiftCert = createSignatureNoiseMessage(authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now - 3600, now + 86400);

      // STR2-style prologue (11 bytes)
      const prologue = Buffer.from([0x09, 0x00, 0x53, 0x54, 0x52, 0x32, 0x01, 0x41, 0x45, 0x53, 0x47]);

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519', prologue);
      const initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519', prologue);

      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(32);

      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(172);

      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(32);
      expect(validateSignatureNoiseMessageEd25519(certificate, ed25519Authority.publicKeyRaw, x25519Keypair.publicKey)).toBe(true);

      // Exchange encrypted messages
      const msg1 = Buffer.from('prologue test initiator');
      const dec1 = responder.decrypt(initiator.encrypt(msg1));
      expect(dec1.toString()).toBe('prologue test initiator');

      const msg2 = Buffer.from('prologue test responder');
      const dec2 = initiator.decrypt(responder.encrypt(msg2));
      expect(dec2.toString()).toBe('prologue test responder');
    });

    it('should fail handshake when prologues differ', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);
      const x25519Cert = createSignatureNoiseMessageEd25519(ed25519Authority, x25519Keypair.publicKey, now - 3600, now + 86400);
      const ellswiftCert = createSignatureNoiseMessage(authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now - 3600, now + 86400);

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      // Responder uses prologue, initiator uses different prologue
      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519', Buffer.from('prologue-A'));
      const initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519', Buffer.from('prologue-B'));

      const act1 = await initiator.generateAct1();
      const act2 = await responder.processAct1(act1);

      // Initiator should fail to decrypt Act 2 due to h state divergence
      expect(() => initiator.processAct2(act2)).toThrow();
    });

    it('should fail X25519 handshake without X25519 config', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticXOnly, now, now + 86400);


      // Config without X25519 fields
      const responder = new Sv2NoiseSession(
        { staticKeypair: serverKeypair, certificateMessage: cert },
        'aes-256-gcm',
        'x25519',
      );

      await expect(responder.processAct1(Buffer.alloc(32))).rejects.toThrow('X25519 static keypair and certificate required');
    });
  });

  // ── BLAKE2s Hash Verification ───────────────────────────────────────

  describe('BLAKE2s Hash', () => {
    it('should produce correct BLAKE2s-256 hash', () => {
      const data = Buffer.from('Noise_NX_25519_AESGCM_BLAKE2s', 'ascii');
      const hash = crypto.createHash('blake2s256').update(data).digest();
      expect(hash.length).toBe(32);
      // Verify it differs from SHA-256 (the whole point of this fix)
      const sha256Hash = crypto.createHash('sha256').update(data).digest();
      expect(hash.equals(sha256Hash)).toBe(false);
    });

    it('should produce correct HMAC-BLAKE2s', () => {
      const key = Buffer.alloc(32, 0xab);
      const data = Buffer.from('test data');
      const hmac = crypto.createHmac('blake2s256', key).update(data).digest();
      expect(hmac.length).toBe(32);
      // Verify it differs from HMAC-SHA256
      const hmacSha = crypto.createHmac('sha256', key).update(data).digest();
      expect(hmac.equals(hmacSha)).toBe(false);
    });
  });

  // ── X25519+AES-GCM+BLAKE2s Full Handshake (BraiinsOS mode) ────────

  describe('X25519+AES-GCM+BLAKE2s Handshake (BraiinsOS)', () => {
    it('should complete handshake using BLAKE2s hash and exchange messages', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);

      const x25519Cert = createSignatureNoiseMessageEd25519(
        ed25519Authority, x25519Keypair.publicKey, now - 3600, now + 86400,
      );
      const ellswiftCert = createSignatureNoiseMessage(
        authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now - 3600, now + 86400,
      );

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      // X25519 mode now defaults to BLAKE2s + AES-GCM
      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519');
      const initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519');

      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(32);

      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(172); // 32 + 48 + 92 (76-byte BraiinsOS cert + MAC)

      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(32);
      expect(certificate.version).toBe(0);
      expect(validateSignatureNoiseMessageEd25519(certificate, ed25519Authority.publicKeyRaw, x25519Keypair.publicKey)).toBe(true);

      // Verify encrypted transport works in both directions
      for (let i = 0; i < 10; i++) {
        const fwd = Buffer.from(`BLAKE2s forward ${i}`);
        expect(responder.decrypt(initiator.encrypt(fwd)).toString()).toBe(`BLAKE2s forward ${i}`);

        const rev = Buffer.from(`BLAKE2s reverse ${i}`);
        expect(initiator.decrypt(responder.encrypt(rev)).toString()).toBe(`BLAKE2s reverse ${i}`);
      }
    });

    it('should complete BLAKE2s handshake with BraiinsOS prologue format', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);

      const x25519Cert = createSignatureNoiseMessageEd25519(
        ed25519Authority, x25519Keypair.publicKey, now - 3600, now + 86400,
      );
      const ellswiftCert = createSignatureNoiseMessage(
        authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now - 3600, now + 86400,
      );

      // BraiinsOS prologue: serialized Prologue { initiator_msg: None, responder_msg: Some(NegotiationMessage) }
      // Format: 0x00 (None) + 0x01 (Some) + NegotiationMessage("STR2" + count=1 + "AESG")
      const prologue = Buffer.from([
        0x00,                         // initiator_msg = None
        0x01,                         // responder_msg = Some
        0x53, 0x54, 0x52, 0x32,       // magic: "STR2"
        0x01,                         // count: 1
        0x41, 0x45, 0x53, 0x47,       // AESGCM: "AESG"
      ]); // 11 bytes total

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519', prologue);
      const initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519', prologue);

      const act1 = await initiator.generateAct1();
      const act2 = await responder.processAct1(act1);
      const { serverStaticKey } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(32);

      // Verify transport
      const msg = Buffer.from('BLAKE2s+BraiinsOS prologue transport test');
      expect(responder.decrypt(initiator.encrypt(msg)).toString()).toBe('BLAKE2s+BraiinsOS prologue transport test');
    });

    it('should produce different handshake state than SHA-256 (cross-hash incompatibility)', async () => {
      // This test verifies that BLAKE2s and SHA-256 produce incompatible handshakes
      // (the root cause of BraiinsOS failures before this fix)
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const ed25519Authority = generateEd25519Keypair();
      const x25519Keypair = generateX25519Keypair();
      const now = Math.floor(Date.now() / 1000);

      const x25519Cert = createSignatureNoiseMessageEd25519(
        ed25519Authority, x25519Keypair.publicKey, now - 3600, now + 86400,
      );
      const ellswiftCert = createSignatureNoiseMessage(
        authorityPrivKey, xOnlyPubKeyFromPriv(serverKeypair.privateKey), now - 3600, now + 86400,
      );

      const config = {
        staticKeypair: serverKeypair,
        certificateMessage: ellswiftCert,
        x25519StaticKeypair: x25519Keypair,
        x25519CertificateMessage: x25519Cert,
      };

      // Responder uses BLAKE2s (X25519 default), initiator overrides to SHA-256 via env
      const responder = new Sv2NoiseSession(config, 'aes-256-gcm', 'x25519');

      // Create an initiator that uses SHA-256 (old behavior) by using env override
      const origEnv = process.env.SV2_X25519_PROTOCOL_NAME;
      process.env.SV2_X25519_PROTOCOL_NAME = 'Noise_NX_25519_AESGCM_SHA256';
      const sha256Initiator = new Sv2NoiseInitiator('aes-256-gcm', 'x25519');
      process.env.SV2_X25519_PROTOCOL_NAME = origEnv;

      const act1 = await sha256Initiator.generateAct1();
      const act2 = await responder.processAct1(act1);

      // SHA-256 initiator should fail to decrypt BLAKE2s Act 2
      expect(() => sha256Initiator.processAct2(act2)).toThrow();
    });
  });

  // ── Ed25519 Certificate & BraiinsOS Format ──────────────────────────

  describe('Ed25519 Certificate (BraiinsOS)', () => {
    it('should generate Ed25519 keypair with 32-byte keys', () => {
      const kp = generateEd25519Keypair();
      expect(kp.publicKeyRaw.length).toBe(32);
      expect(kp.privateKeyRaw.length).toBe(32);
    });

    it('should create and validate Ed25519 SignatureNoiseMessage', () => {
      const authority = generateEd25519Keypair();
      const staticPubKey = crypto.randomBytes(32);
      const now = Math.floor(Date.now() / 1000);

      const cert = createSignatureNoiseMessageEd25519(
        authority, staticPubKey, now - 3600, now + 86400,
      );

      expect(cert.version).toBe(0);
      expect(cert.signature.length).toBe(64);
      expect(validateSignatureNoiseMessageEd25519(cert, authority.publicKeyRaw, staticPubKey)).toBe(true);
    });

    it('should fail Ed25519 validation with wrong authority key', () => {
      const authority = generateEd25519Keypair();
      const wrongAuthority = generateEd25519Keypair();
      const staticPubKey = crypto.randomBytes(32);
      const now = Math.floor(Date.now() / 1000);

      const cert = createSignatureNoiseMessageEd25519(
        authority, staticPubKey, now - 3600, now + 86400,
      );

      expect(validateSignatureNoiseMessageEd25519(cert, wrongAuthority.publicKeyRaw, staticPubKey)).toBe(false);
    });

    it('should serialize BraiinsOS format to 76 bytes with U16 sig_len prefix', () => {
      const msg = {
        version: 0,
        validFrom: 1700000000,
        notValidAfter: 1700086400,
        signature: crypto.randomBytes(64),
      };
      const buf = serializeSignatureNoiseMessageBraiins(msg);
      expect(buf.length).toBe(76);

      // Check U16 sig_len at offset 10
      expect(buf.readUInt16LE(10)).toBe(64);

      // Round-trip
      const result = deserializeSignatureNoiseMessageBraiins(buf);
      expect(result.version).toBe(msg.version);
      expect(result.validFrom).toBe(msg.validFrom);
      expect(result.notValidAfter).toBe(msg.notValidAfter);
      expect(result.signature.equals(msg.signature)).toBe(true);
    });

    it('should produce different bytes than standard 74-byte format', () => {
      const msg = {
        version: 0,
        validFrom: 1700000000,
        notValidAfter: 1700086400,
        signature: crypto.randomBytes(64),
      };
      const standard = serializeSignatureNoiseMessage(msg);
      const braiins = serializeSignatureNoiseMessageBraiins(msg);

      expect(standard.length).toBe(74);
      expect(braiins.length).toBe(76);

      // First 10 bytes should be identical (version + validFrom + notValidAfter)
      expect(standard.subarray(0, 10).equals(braiins.subarray(0, 10))).toBe(true);

      // BraiinsOS has 2 extra bytes (sig_len) at offset 10
      expect(braiins.readUInt16LE(10)).toBe(64);

      // Signature starts at offset 10 in standard, offset 12 in BraiinsOS
      expect(standard.subarray(10).equals(braiins.subarray(12))).toBe(true);
    });
  });

  // ── AES-GCM CipherState ─────────────────────────────────────────────

  describe('CipherState AES-256-GCM', () => {
    it('should encrypt and decrypt with AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      const plaintext = Buffer.from('test message for AES-GCM cipher state');
      const ciphertext = enc.encryptWithAd(ad, plaintext);

      expect(ciphertext.length).toBe(plaintext.length + SV2_MAC_SIZE);
      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should handle multiple sequential encryptions with AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      for (let i = 0; i < 10; i++) {
        const pt = Buffer.from(`AES-GCM message ${i}`);
        const ct = enc.encryptWithAd(ad, pt);
        const result = dec.decryptWithAd(ad, ct);
        expect(result.toString()).toBe(`AES-GCM message ${i}`);
      }
    });

    it('should encrypt and decrypt with non-empty AD using AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.from('additional data');
      const plaintext = Buffer.from('secret payload');
      const ciphertext = enc.encryptWithAd(ad, plaintext);
      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });
});
