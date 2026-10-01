import { seal } from '@sold/identity';
import { json } from '../../../../../../server/commerce-http';
import { route } from '../../../../../../server/route';
import { getRuntime } from '../../../../../../server/runtime';
import { samlClient, ssoStateKey } from '../../../../../../server/sso';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const client = samlClient();
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
  // The IdP POSTs back from another site, and only SameSite=None cookies travel on a cross-site POST. That needs https; in
  // local development (http) it falls back to Lax, which works for same-site testing only.
  res.headers.append(
    'set-cookie',
    `${secure ? '__Host-' : ''}sold_saml=${seal(ssoStateKey(), saved, 600)}; Path=/; HttpOnly; Max-Age=600; SameSite=${secure ? 'None; Secure' : 'Lax'}`,
  );
  return res;
});
