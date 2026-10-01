import { z } from 'zod';
import { eq, schema } from '@sold/db';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';

export const dynamic = 'force-dynamic';

const idOf = (req: Request) => parseId(new URL(req.url).pathname.split('/').pop());

export const PATCH = adminRoute('settings:write', async (req, { db, audit }) => {
  const id = idOf(req);
  const v = await body(req, z.strictObject({ active: z.boolean() }));
  await db
    .update(schema.webhookEndpoints)
    .set({ active: v.active })
    .where(eq(schema.webhookEndpoints.id, id));
  await audit('webhook.active', { type: 'webhook', id }, v);
  return json({ ok: true });
});

export const DELETE = adminRoute('settings:write', async (req, { db, audit }) => {
  const id = idOf(req);
  await db.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
  await audit('webhook.deleted', { type: 'webhook', id });
  return json({ ok: true });
});
