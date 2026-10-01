import { completeSsoLogin, open, SsoError } from '@sold/identity';
import { clearSsoCookie, ssoRedirectPage } from '../../../../../../server/sso-http';
import {
  clientIp,
  getIdentity,
  readCookie,
  sessionCookie,
} from '../../../../../../server/identity';
import { route } from '../../../../../../server/route';
import { getRuntime } from '../../../../../../server/runtime';
import { oidcClient, ssoRules, ssoStateKey } from '../../../../../../server/sso';

export const dynamic = 'force-dynamic';

export const GET = route(async (request, ctx) => {
  const client = oidcClient();
  if (!client) return ssoRedirectPage('/admin/login?error=sso_unavailable');
  const secure = getRuntime().env.SOLD_ENVIRONMENT !== 'local';
  const url = new URL(request.url);
  const saved = open<{ state: string; nonce: string; verifier: string }>(
    ssoStateKey(),
    readCookie(request.headers.get('cookie'), `${secure ? '__Host-' : ''}sold_oidc`),
  );
  try {
    if (!saved) throw new SsoError('state_expired');
    const identity = await client.finish(
      {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      },
      saved,
    );
    const { sessions } = getIdentity();
    const out = await completeSsoLogin(
      getRuntime().db.primary,
      sessions,
      ssoRules('oidc'),
      identity,
      { ip: clientIp(request), userAgent: request.headers.get('user-agent') },
    );
    const res = ssoRedirectPage('/admin');
    res.headers.append('set-cookie', sessionCookie('staff', out.token, out.expiresAt));
    res.headers.append('set-cookie', clearSsoCookie('sold_oidc'));
    return res;
  } catch (error) {
    // The reason is for operators (logs); the browser only learns that it failed.
    ctx.log.warn(
      { reason: error instanceof SsoError ? error.reason : 'error', provider: 'oidc' },
      'sso sign-in refused',
    );
    const res = ssoRedirectPage('/admin/login?error=sso_failed');
    res.headers.append('set-cookie', clearSsoCookie('sold_oidc'));
    return res;
  }
});
