// Test that our Noise handshake hash matches Rust implementation
const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function mixHash(h, data) {
  return sha256(Buffer.concat([h, data]));
}

// From logs
const initiatorEphemeralPub = Buffer.from('8346a359eeaa46f5a79fbf81c915dfeca99b9e9fe0b10169b9eb1da3f862f0bd369c434a283f3f3d5325ca822e2ccce7387e03c5ebbaae4fab58a7d9bc22bc48', 'hex');
const responderEphemeralPub = Buffer.from('450040ba3823fb7b612d8cbbbadfc46281a23c98b0b247dd12812f9b8b341707339369fd5ebfa56cc2c0b3e614d092ad350e5dcff33465bea182f63bb0aee12e', 'hex');

// Step 0: Initial h = SHA256(protocol name)
const protocolName = 'Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256';
let h = sha256(Buffer.from(protocolName, 'ascii'));
console.log('Step 0 - Initial h:', h.toString('hex'));
console.log('Expected:           2eb47881208e9eee1f669f67c66ee70ea9ea88090d503fe830dc4bc83e29bf10\n');

// RESPONDER receives Act 1 from initiator

// Step 1: MixHash(initiator ephemeral pub)
h = mixHash(h, initiatorEphemeralPub);
console.log('Step 1 - After MixHash(initiator_eph_pub, 64b):');
console.log('  Computed:', h.toString('hex').substring(0, 32) + '...');
console.log('  From logs: f7293acf10b8061c522285756ed2cf6b...');
console.log('  Match:', h.toString('hex').startsWith('f7293acf10b8061c522285756ed2cf6b') ? '✅ YES' : '❌ NO\n');

// Step 2: MixHash(empty) - from decryptAndHash(Buffer.alloc(0))
h = mixHash(h, Buffer.alloc(0));
console.log('Step 2 - After MixHash(empty, 0b):');
console.log('  Computed:', h.toString('hex').substring(0, 32) + '...');
console.log('  From logs: e83cf906f2955f2253bd053ed724dd90...');
console.log('  Match:', h.toString('hex').startsWith('e83cf906f2955f2253bd053ed724dd90') ? '✅ YES' : '❌ NO\n');

// Step 3: MixHash(responder ephemeral pub)
h = mixHash(h, responderEphemeralPub);
console.log('Step 3 - After MixHash(responder_eph_pub, 64b):');
console.log('  Computed:', h.toString('hex').substring(0, 32) + '...');
console.log('  From logs: 917fbf6b2a9bd5ee8c4fd0ac49855529...');
console.log('  Match:', h.toString('hex').startsWith('917fbf6b2a9bd5ee8c4fd0ac49855529') ? '✅ YES' : '❌ NO\n');

console.log('\n=== INITIATOR PERSPECTIVE ===\n');

// What the INITIATOR should have after sending Act 1
let h_init = sha256(Buffer.from(protocolName, 'ascii'));
console.log('Initiator Step 0 - Initial h:', h_init.toString('hex').substring(0, 32) + '...');

// Initiator: MixHash(their own ephemeral pub)
h_init = mixHash(h_init, initiatorEphemeralPub);
console.log('Initiator Step 1 - After MixHash(initiator_eph_pub):', h_init.toString('hex').substring(0, 32) + '...');

// Initiator: EncryptAndHash(empty) - same as MixHash(empty) when k=None
h_init = mixHash(h_init, Buffer.alloc(0));
console.log('Initiator Step 2 - After EncryptAndHash(empty):', h_init.toString('hex').substring(0, 32) + '...');

// Initiator receives Act 2: MixHash(responder ephemeral pub)
h_init = mixHash(h_init, responderEphemeralPub);
console.log('Initiator Step 3 - After MixHash(responder_eph_pub):', h_init.toString('hex').substring(0, 32) + '...');

console.log('\n=== COMPARISON ===\n');
console.log('Responder h after step 3:', h.toString('hex').substring(0, 32) + '...');
console.log('Initiator h after step 3:', h_init.toString('hex').substring(0, 32) + '...');
console.log('Match:', h.equals(h_init) ? '✅ YES - Handshake hashes match!' : '❌ NO - MISMATCH!');

if (!h.equals(h_init)) {
  console.log('\n⚠️  PROBLEM: Handshake hashes diverge!');
  console.log('This explains why decryption fails - AD is different.\n');
}
