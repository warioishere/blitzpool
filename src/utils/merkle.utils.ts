/**
 * Convert an array of hex-encoded merkle branch hashes to 32-byte Buffers.
 * Pads or truncates to exactly 32 bytes if needed.
 */
export function merkleBranchToBuffers(merkleBranch: string[]): Buffer[] {
  return merkleBranch.map((hex) => {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      const padded = Buffer.alloc(32);
      buf.copy(padded, 0, 0, Math.min(buf.length, 32));
      return padded;
    }
    return buf;
  });
}
