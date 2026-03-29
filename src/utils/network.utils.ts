/**
 * Normalize IPv6-mapped IPv4 addresses to plain IPv4.
 * E.g., "::ffff:192.168.1.84" → "192.168.1.84"
 */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}
