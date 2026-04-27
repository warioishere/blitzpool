/**
 * Normalize a BTC mining address for equality / storage.
 *
 * Bech32 and bech32m (BIP-173 / BIP-350) are protocol-specified as
 * lowercase on the wire. Wallets / UIs may present them uppercase as a
 * QR-code optimization, but every string comparison downstream has to
 * treat them case-insensitively or an address invited in one case and
 * mined in the other will silently miss the member cache lookup and
 * shares will route to solo/PPLNS instead of the intended group.
 *
 * Legacy P2PKH/P2SH (base58, starting with 1/3/m/n/2) IS case-sensitive —
 * `1A1zP...` and `1a1zp...` are different addresses with different
 * checksums. Those we leave untouched.
 *
 * Accepts the common mainnet, testnet and regtest bech32 prefixes:
 *   bc1 / tb1 / bcrt1
 * plus signet (tb1 is shared, sb1 for Signet BIP-0350 variant — some
 * wallets still use tb1 there).
 */
export function normalizeBtcAddress(address: string | undefined | null): string {
    const trimmed = (address ?? '').trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (
        lower.startsWith('bc1')
        || lower.startsWith('tb1')
        || lower.startsWith('bcrt1')
        || lower.startsWith('sb1')
    ) {
        return lower;
    }
    return trimmed;
}
