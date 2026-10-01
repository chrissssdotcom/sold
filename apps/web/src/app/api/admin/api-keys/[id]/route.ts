import { NotFoundError } from '@sold/commerce';
import { revokeApiKey } from '@sold/platform';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { parseId } from '../../../../../server/admin/http';

export const dynamic = 'force-dynamic';

export const DELETE = adminRoute('settings:write', async (req, { db, audit }) => {
  const id = parseId(new URL(req.url).pathname.split('/').pop());
  if (!(await revokeApiKey(db, id))) throw new NotFoundError('API key', id);
  await audit('apikey.revoked', { type: 'api_key', id });
  return json({ ok: true });
});
