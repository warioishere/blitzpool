// Quick test to verify our Act 2 is valid by decrypting it with our own initiator
const crypto = require('crypto');

async function testAct2() {
  // Import from compiled JS
  const { Sv2NoiseInitiator } = require('./dist/models/sv2/sv2-noise');

  // Real Act 1 from miner (64 bytes)
  const act1Hex = '7faa6c0a8c26fd37874a7bf6226cf851210a04f94ddc8af3ebadd0680b0ae678' +
                  '3e3f4aac4f933f6e0ea51f5eeeee94419e7f22ff0d4e1e50e3ec0cc5e3e05d2b';
  const act1 = Buffer.from(act1Hex, 'hex');

  // Real Act 2 from pool (234 bytes) - first 128 chars from log
  const act2Start = 'a4c157944c2fb096240c8142f78d1b7298f6d8aae0b3e3dd832f154491195768f19942ad054577c138a8ddf675976e25d3b65ed0b51a66b8d180391514f3ba21';
  const act2Part1 = '3970cbb6359f55bf5feaaf0de0e709a005ca80ead10ddf65'; // encrypted static (first 48 chars)
  const act2Part2 = 'c6d45ba2e4dda00bea04cd96bd86639e7ef8480675149e48'; // encrypted cert (first 48 chars)

  console.log('Testing Act 2 decryption with our own initiator...');
  console.log('Act 1 (64 bytes):', act1Hex.substring(0, 64) + '...');
  console.log('Act 2 server ephemeral:', act2Start.substring(0, 64) + '...');
  console.log('Act 2 encrypted static:', act2Part1 + '...');
  console.log('Act 2 encrypted cert:', act2Part2 + '...');

  console.log('\nNote: This test needs the FULL Act 2 hex (all 234 bytes).');
  console.log('The logs only showed partial hex. We need the complete Act 2 to test decryption.');
}

testAct2().catch(console.error);
