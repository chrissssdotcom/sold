import { z } from 'zod';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';
import * as q from '../../../../server/admin/queries';
import { getIdentity } from '../../../../server/identity';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('users:read', async (_req, { db }) => json(await q.listStaff(db)));

const create = z.strictObject({
  email: z.string().max(254),
  name: z.string().max(120).default(''),
  password: z.string().max(200).optional(),
  roles: z.array(z.string().max(60)).max(20).default([]),
});

export const POST = adminRoute('users:write', async (req, { db, user }) => {
  const v = await body(req, create);
  const created = await getIdentity().auth.createStaff(db, {
    ...v,
    actor: { id: user.id, label: user.email },
  });
  return json({ id: created.id, email: created.email }, { status: 201 });
});
