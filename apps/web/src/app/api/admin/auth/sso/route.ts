import { json } from '../../../../../server/commerce-http';
import { route } from '../../../../../server/route';
import { ssoMethods } from '../../../../../server/sso';

export const dynamic = 'force-dynamic';

/** Which sign-in methods the login page should offer. Public; reveals configuration only, never secrets. */
export const GET = route(async () =>
  json({ password: true, ...ssoMethods() }, { headers: { 'cache-control': 'public, max-age=60' } }),
);
