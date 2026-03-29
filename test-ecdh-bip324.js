// Test BIP-324 ECDH to verify it matches Rust secp256k1 implementation
const crypto = require('crypto');

async function testEcdhBip324() {
  // Import from compiled JS
  const { loadEllSwift } = require('./dist/models/sv2/sv2-noise');
  const ellSwift = await loadEllSwift();

  console.log('Testing BIP-324 ECDH implementation...\n');

  // Known test vector (from BIP-324 or Rust tests)
  // We'll use fixed keys to get reproducible results
  const priv1 = Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex');
  const priv2 = Buffer.from('2222222222222222222222222222222222222222222222222222222222222222', 'hex');

  // Generate EllSwift encodings for both keys
  const kp1 = ellSwift.keygen(new Uint8Array(priv1));
  const kp2 = ellSwift.keygen(new Uint8Array(priv2));

  const pub1 = Buffer.from(kp1.publicKey); // 64 bytes
  const pub2 = Buffer.from(kp2.publicKey); // 64 bytes

  console.log('Key 1:');
  console.log(`  Private: ${priv1.toString('hex')}`);
  console.log(`  Public (EllSwift): ${pub1.toString('hex')}`);
  console.log('\nKey 2:');
  console.log(`  Private: ${priv2.toString('hex')}`);
  console.log(`  Public (EllSwift): ${pub2.toString('hex')}`);

  // Party 1 as initiator (true)
  const secret1_as_initiator = ellSwift.getSharedSecretBip324(
    new Uint8Array(priv1),
    new Uint8Array(pub2),
    new Uint8Array(pub1),
    true  // initiator
  );

  // Party 2 as responder (false)
  const secret2_as_responder = ellSwift.getSharedSecretBip324(
    new Uint8Array(priv2),
    new Uint8Array(pub1),
    new Uint8Array(pub2),
    false  // responder
  );

  console.log('\n=== BIP-324 ECDH Results ===');
  console.log('Party 1 (initiator) computed:', Buffer.from(secret1_as_initiator).toString('hex'));
  console.log('Party 2 (responder) computed:', Buffer.from(secret2_as_responder).toString('hex'));
  console.log('Match:', Buffer.from(secret1_as_initiator).equals(Buffer.from(secret2_as_responder)) ? '✓ YES' : '✗ NO');

  // Also test basic (non-BIP-324) ECDH for comparison
  const secret1_basic = ellSwift.getSharedSecret(
    new Uint8Array(priv1),
    new Uint8Array(pub2)
  );

  const secret2_basic = ellSwift.getSharedSecret(
    new Uint8Array(priv2),
    new Uint8Array(pub1)
  );

  console.log('\n=== Basic ECDH Results (no BIP-324) ===');
  console.log('Party 1 computed:', Buffer.from(secret1_basic).toString('hex'));
  console.log('Party 2 computed:', Buffer.from(secret2_basic).toString('hex'));
  console.log('Match:', Buffer.from(secret1_basic).equals(Buffer.from(secret2_basic)) ? '✓ YES' : '✗ NO');

  console.log('\n=== Comparison ===');
  console.log('BIP-324 vs Basic same?', Buffer.from(secret1_as_initiator).equals(Buffer.from(secret1_basic)) ? 'YES' : 'NO');
}

testEcdhBip324().catch(console.error);
