import { CommerceError } from '@sold/commerce';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export class CsrfError extends CommerceError {
  constructor() {
    super('csrf_rejected', 'Cross-site request refused', 403);
  }
}

/**
 * Hosts this request may legitimately be "same origin" with. `request.url` is NOT enough: in the container Next builds it from
 * `HOSTNAME` (0.0.0.0), so it never matches the `Origin` a browser sends. The `Host` header is what the browser addressed (a
 * cross-site attacker cannot make the victim's browser send a different one), and `SOLD_PUBLIC_URL` covers proxies that rewrite it.
 */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>([new URL(request.url).host.toLowerCase()]);
  const header = request.headers.get('host');
  if (header) hosts.add(header.toLowerCase());
  const pub = process.env['SOLD_PUBLIC_URL'];
  if (pub) {
    try {
      hosts.add(new URL(pub).host.toLowerCase());
    } catch {
      // a malformed public URL is caught at boot by env validation; here it simply adds nothing
    }
  }
  return hosts;
}

/**
 * Cookie-authenticated, state-changing requests must come from our own pages. Defence in depth on top of SameSite cookies:
 *  1. `Origin` (or `Referer`) must be present and match this host; browsers always send it on cross-site POSTs.
 *  2. The body must be JSON, which a plain HTML form cannot send.
 * Non-browser API clients that use bearer tokens do not go through here.
 */
export function assertSameOrigin(request: Request, opts: { requireJson?: boolean } = {}): void {
  if (SAFE.has(request.method)) return;
  const hosts = ownHosts(request);
  const origin = request.headers.get('origin') ?? request.headers.get('referer');
  let originHost: string | null;
  try {
    originHost = origin ? new URL(origin).host.toLowerCase() : null;
  } catch {
    originHost = null;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    !(originHost !== null && hosts.has(originHost)) &&
    !(originHost === null && fetchSite === 'same-origin')
  )
    throw new CsrfError();
  // A request that carries a body must carry JSON (a plain HTML form cannot). A bodyless request (DELETE, an action POST) has
  // nothing to disguise; the Origin check above is what stops cross-site ones.
  const hasBody =
    Number(request.headers.get('content-length') ?? '0') > 0 ||
    request.headers.has('transfer-encoding');
  // (HTTP/2 may omit Content-Length, so any declared content type also counts as "has a body".)
  const type = request.headers.get('content-type');
  if (opts.requireJson !== false && (hasBody || type !== null)) {
    if (!/^application\/json\b/i.test(type ?? '')) throw new CsrfError();
  }
}
