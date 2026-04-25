/**
 * Mask an email for public display: first char of the local part + domain.
 * Used wherever a verified-email binding is exposed on a public URL —
 * the owner already knows their own email, and outsiders only need a
 * hint ("yes, something is bound, prefix is `a***`") rather than the
 * full address.
 *
 * Returns '' for empty input and '***' if the input has no '@' (defense
 * against malformed rows; should not happen in practice).
 */
export function maskEmail(email: string): string {
    if (!email) return '';
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
}
