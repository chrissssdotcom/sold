import { z } from 'zod';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';
import { getIdentity } from '../../../../../server/identity';

export const dynamic = 'force-dynamic';
export const PATCH = adminRoute('users:write', async (req, { db, user }) => {
  const id = parseId(new URL(req.url).pathname.split('/').pop());
  const v = await body(req, z.strictObject({ status: z.enum(['active', 'disabled']) }));
  if (id === user.id && v.status === 'disabled')
    return json(
      { error: { code: 'self_disable', message: 'You cannot disable your own account' } },
      { status: 409 },
    );
  await getIdentity().auth.setStatus(db, id, v.status, { id: user.id, label: user.email });
  return json({ ok: true });
});
