import { getRuntime } from './runtime';

/**
 * A staff session cookie is SameSite=Strict, and a redirect chain that STARTED at another site (the identity provider) is
 * treated as cross-site all the way along. So after SSO we answer with a tiny page whose own meta-refresh makes the final
 * navigation same-site, and the Strict cookie accompanies it.
 */
export function ssoRedirectPage(to: string): Response {
  const safe = to.startsWith('/') && !to.startsWith('//') ? to : '/admin';
  const escaped = safe.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escaped}"><title>Signing in…</title><a href="${escaped}">Continue</a>`,
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    },
  );
}

export function clearSsoCookie(name: string): string {
  const secure = getRuntime().env.SOLD_ENVIRONMENT !== 'local';
  return `${secure ? '__Host-' : ''}${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
