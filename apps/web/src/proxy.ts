import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, cspHeaderName, cspMode, parseHosts } from './server/csp';
import { localeSlugs, negotiateMarket, reservedPrefixes } from '@sold/storefront/i18n';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Assign/propagate a request ID before anything else runs. Kept deliberately tiny: it runs on every request. */
/** `/products` -> `/en-au/products`: storefront pages always live under a market prefix. */
function localeRedirect(request: NextRequest): NextResponse | null {
  const { pathname, search } = request.nextUrl;
  const first = pathname.split('/')[1] ?? '';
  if (
    localeSlugs.includes(first) ||
    reservedPrefixes.includes(first) ||
    /\.[a-z0-9]+$/i.test(pathname)
  )
    return null;
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const market = negotiateMarket(request.headers.get('accept-language'));
  const url = request.nextUrl.clone();
  url.pathname = `/${market.slug}${pathname === '/' ? '' : pathname}`;
  url.search = search;
  const res = NextResponse.redirect(url, 307);
  res.headers.set('Vary', 'Accept-Language');
  return res;
}

export function proxy(request: NextRequest) {
  const redirect = localeRedirect(request);
  if (redirect) return redirect;
  const inbound = request.headers.get('x-request-id');
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-request-id', requestId);
  // CSP: strict nonce posture for the (dynamic) console, allowlist posture for the cacheable storefront. Read at request time.
  const mode = cspMode(process.env['SOLD_CSP']);
  let csp: string | null = null;
  // /media/* sets its own, stricter policy (default-src 'none'); do not overwrite it.
  if (mode !== 'off' && !request.nextUrl.pathname.startsWith('/media/')) {
    const isConsole =
      request.nextUrl.pathname === '/admin' || request.nextUrl.pathname.startsWith('/admin/');
    const nonce = isConsole ? btoa(crypto.randomUUID()) : undefined;
    csp = buildCsp({
      ...(nonce ? { nonce } : {}),
      scriptHosts: parseHosts(process.env['SOLD_CSP_SCRIPT_HOSTS']),
      connectHosts: parseHosts(process.env['SOLD_CSP_CONNECT_HOSTS']),
      frameHosts: parseHosts(process.env['SOLD_CSP_FRAME_HOSTS']),
      dev: process.env.NODE_ENV !== 'production',
    });
    // Next reads the nonce from the *request's* CSP header and stamps it onto its own scripts.
    headers.set(cspHeaderName(mode), csp);
    if (nonce) headers.set('x-nonce', nonce);
  }
  const response = NextResponse.next({ request: { headers } });
  if (csp) response.headers.set(cspHeaderName(mode), csp);
  response.headers.set('x-request-id', requestId);
  // Read at REQUEST time so one build/image can be promoted dev -> stage -> prod (Section 8C.6). A header set in
  // next.config would be frozen at build time. Mirrors safetySwitchesFor(env).blockIndexing in @sold/core.
  if (process.env['SOLD_ENVIRONMENT'] !== 'prod')
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  // Skip static assets and image optimisation: they never need a request ID.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
