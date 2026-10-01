import { seal } from '@sold/identity';
import { json } from '../../../../../../server/commerce-http';
import { route } from '../../../../../../server/route';
import { getRuntime } from '../../../../../../server/runtime';
import { oidcClient, ssoStateKey } from '../../../../../../server/sso';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const client = oidcClient();
  if (!client)
    return json(
      { error: { code: 'not_configured', message: 'Single sign-on is not configured' } },
      { status: 404 },
    );
  const { url, saved } = await client.start();
  const secure = getRuntime().env.SOLD_ENVIRONMENT !== 'local';
  const res = new Response(null, {
    status: 302,
    headers: { location: url, 'cache-control': 'no-store' },
  });
  // State, nonce and PKCE verifier ride in a sealed, short-lived, HttpOnly cookie scoped to the callback. Lax: the IdP's
  // redirect back is a top-level GET, which Lax cookies accompany.
  res.headers.append(
    'set-cookie',
    `${secure ? '__Host-' : ''}sold_oidc=${seal(ssoStateKey(), saved, 600)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
  );
  return res;
});
