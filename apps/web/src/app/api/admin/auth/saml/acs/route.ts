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
import { samlClient, ssoRules, ssoStateKey } from '../../../../../../server/sso';

export const dynamic = 'force-dynamic';

/**
 * SAML assertion consumer service. This is a cross-site form POST by design, so there is no same-origin check: the
 * protection is the signed assertion, the InResponseTo binding to the sealed request id in OUR cookie, and replay refusal.
 */
export const POST = route(async (request, ctx) => {
  const client = samlClient();
  if (!client) return ssoRedirectPage('/admin/login?error=sso_unavailable');
  const rt = getRuntime();
  const secure = rt.env.SOLD_ENVIRONMENT !== 'local';
  const saved = open<{ requestId: string }>(
    ssoStateKey(),
    readCookie(request.headers.get('cookie'), `${secure ? '__Host-' : ''}sold_saml`),
  );
  try {
    if (!saved) throw new SsoError('state_expired');
    const form = await request.formData();
    const response = form.get('SAMLResponse');
    const identity = await client.finish(
      { SAMLResponse: typeof response === 'string' ? response : null },
      saved,
      rt.db.primary,
    );
    const out = await completeSsoLogin(
      rt.db.primary,
      getIdentity().sessions,
      ssoRules('saml'),
      identity,
      { ip: clientIp(request), userAgent: request.headers.get('user-agent') },
    );
    const res = ssoRedirectPage('/admin');
    res.headers.append('set-cookie', sessionCookie('staff', out.token, out.expiresAt));
    res.headers.append('set-cookie', clearSsoCookie('sold_saml'));
    return res;
  } catch (error) {
    ctx.log.warn(
      { reason: error instanceof SsoError ? error.reason : 'error', provider: 'saml' },
      'sso sign-in refused',
    );
    const res = ssoRedirectPage('/admin/login?error=sso_failed');
    res.headers.append('set-cookie', clearSsoCookie('sold_saml'));
    return res;
  }
});
