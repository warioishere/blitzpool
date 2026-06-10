/**
 * Block subsidy in sats for `height` per the standard halving schedule
 * (50 BTC, halving every 210 000 blocks; 0 after 64 halvings). Pure function,
 * shared by the next-block-reward endpoint and the group finder-bonus-cap
 * endpoint so the subsidy is computed identically in both places.
 */
export function blockSubsidySats(height: number): number {
    const halvings = Math.floor(height / 210_000);
    if (halvings >= 64) return 0;
    return Math.floor(5_000_000_000 / Math.pow(2, halvings));
}
