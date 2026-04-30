/**
 * Mask an email for display: first char of local part, first char of
 * the second-level domain, TLD-and-below preserved. So:
 *   alice@gmail.com        → a***@g***.com
 *   bob@joe.de             → b***@j***.de
 *   carol@example.co.uk    → c***@e***.co.uk
 *
 * Used wherever an email binding is exposed to anyone other than the
 * binding owner — including admin-side dashboards, public banners, and
 * notification side-channels. The strict form (vs. previous `a***@gmail.com`)
 * means even a leaked admin token can't reveal the full email when the
 * user has a custom domain (`joe@joe.de` would otherwise pinpoint identity).
 *
 * The owner already knows their own email; the mask is defensive output
 * for everyone else. Returns '' for empty input and '***' for malformed
 * shapes (no '@').
 */
export function maskEmail(email: string): string {
    if (!email) return '';
    const atIdx = email.indexOf('@');
    if (atIdx <= 0 || atIdx === email.length - 1) return '***';
    const local = email.slice(0, atIdx);
    const domain = email.slice(atIdx + 1);
    const localHead = local.slice(0, 1);
    const dotIdx = domain.indexOf('.');
    if (dotIdx <= 0) {
        // No TLD (e.g. `joe@localhost`) — mask everything after the @.
        return `${localHead}***@***`;
    }
    const domainHead = domain.slice(0, 1);
    const tldAndBelow = domain.slice(dotIdx); // includes the leading dot
    return `${localHead}***@${domainHead}***${tldAndBelow}`;
}
