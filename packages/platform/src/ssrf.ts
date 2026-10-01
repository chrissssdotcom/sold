import { isIP } from 'node:net';

/**
 * Is this address one a webhook must never be sent to? Loopback, private (RFC 1918 / ULA), link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, multicast, reserved, unspecified, and IPv4-mapped IPv6 of any of those.
 */
export function isForbiddenAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return forbidden4(address);
  if (v === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return forbidden4(mapped[1]!);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return forbidden4(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fe8') ||
      a.startsWith('fe9') ||
      a.startsWith('fea') ||
      a.startsWith('feb') || // fe80::/10 link-local
      a.startsWith('fc') ||
      a.startsWith('fd') || // fc00::/7 unique local
      a.startsWith('ff') || // multicast
      a.startsWith('64:ff9b:') || // NAT64
      a.startsWith('2001:db8') || // documentation
      a.startsWith('100:') // discard
    );
  }
  return true; // not an IP literal: callers must resolve first
}

function forbidden4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

export interface UrlPolicy {
  /** Allow http:// and private/loopback targets. Local development and tests only. */
  allowPrivate: boolean;
}

/** Static checks on a webhook URL (scheme, credentials, literal hosts). Resolution is checked again at connect time. */
export function validateWebhookUrl(raw: string, policy: UrlPolicy): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.username || u.password) return 'URLs with embedded credentials are not allowed';
  if (u.protocol !== 'https:' && !(policy.allowPrivate && u.protocol === 'http:'))
    return 'must be an https:// URL';
  if (!policy.allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isForbiddenAddress(host)) return 'points at a private or reserved address';
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
      return 'points at a local hostname';
  }
  return null;
}
