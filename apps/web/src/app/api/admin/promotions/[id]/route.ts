import { z } from 'zod';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';
import { PromotionService } from '@sold/commerce';

export const dynamic = 'force-dynamic';
export const PATCH = adminRoute('promotions:write', async (req, { db, audit }) => {
  const id = parseId(new URL(req.url).pathname.split('/').pop());
  const v = await body(req, z.strictObject({ active: z.boolean() }));
  await new PromotionService().setActive(db, id, v.active);
  await audit('promotion.active', { type: 'promotion', id }, v);
  return json({ ok: true });
});
