import { NextResponse, type NextRequest } from 'next/server';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Assign/propagate a request ID before anything else runs. Kept deliberately tiny: it runs on every request. */
export function proxy(request: NextRequest) {
  const inbound = request.headers.get('x-request-id');
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-request-id', requestId);
  const response = NextResponse.next({ request: { headers } });
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
