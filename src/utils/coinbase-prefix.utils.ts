/**
 * Patch the scriptSig length varint at offset 41 of a non-witness coinbase
 * prefix when the channel's total extranonce is not the pool's default 12 bytes
 * (4-byte enonce1 + 8-byte enonce2 — Braiins Hashpower marketplace requires
 * extranonce2_size >= 7).
 *
 * Offset breakdown (non-witness coinbase):
 *   version(4) + input_count(1) + prev_txid(32) + input_index(4) = 41
 *
 * Used by StratumV2Client (production) and v2-extended-regtest (tests) so
 * both always stay in sync.
 */
export function patchCoinbasePrefixVarint(prefix: Buffer, totalExtranonceSize: number): Buffer {
    if (totalExtranonceSize === 12) return prefix;
    if (prefix.length < 42) return prefix;
    const patched = Buffer.from(prefix);
    const newVarint = patched[41] + (totalExtranonceSize - 12);
    if (newVarint < 0 || newVarint > 0xFC) return prefix;
    patched[41] = newVarint;
    return patched;
}
