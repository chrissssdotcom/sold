import { adminRoute } from '../../../../../../../server/admin-route';
import { json } from '../../../../../../../server/commerce-http';
import { parseId } from '../../../../../../../server/admin/http';
import { getIdentity } from '../../../../../../../server/identity';

export const dynamic = 'force-dynamic';
const params = (req: Request) => {
  const parts = new URL(req.url).pathname.split('/');
  return {
    id: parseId(parts[parts.length - 3]),
    role: decodeURIComponent(parts[parts.length - 1] ?? ''),
  };
};

export const PUT = adminRoute('users:roles', async (req, { db, user }) => {
  const { id, role } = params(req);
  await getIdentity().roles.assign(db, id, role, { id: user.id, label: user.email });
  return json({ ok: true });
});

export const DELETE = adminRoute('users:roles', async (req, { db, user }) => {
  const { id, role } = params(req);
  await getIdentity().roles.revoke(db, id, role, { id: user.id, label: user.email });
  return json({ ok: true });
});
