import { z } from 'zod';
import { NotFoundError } from '@sold/commerce';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';
import { getMedia } from '../../../../../server/media';

export const dynamic = 'force-dynamic';
const idOf = (req: Request) => parseId(new URL(req.url).pathname.split('/').pop());

export const PATCH = adminRoute('content:write', async (req, { db, audit }) => {
  const id = idOf(req);
  const v = await body(req, z.strictObject({ alt: z.string().max(300) }));
  if (!(await getMedia().setAlt(db, id, v.alt))) throw new NotFoundError('Media', id);
  await audit('media.alt', { type: 'media', id });
  return json({ ok: true });
});

export const DELETE = adminRoute('content:write', async (req, { db, audit }) => {
  const id = idOf(req);
  if (!(await getMedia().remove(db, id))) throw new NotFoundError('Media', id);
  await audit('media.deleted', { type: 'media', id });
  return json({ ok: true });
});
