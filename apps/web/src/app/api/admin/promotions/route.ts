import { z } from 'zod';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import * as q from '../../../../server/admin/queries';
import { PromotionService } from '@sold/commerce';

export const dynamic = 'force-dynamic';
const svc = new PromotionService();

export const GET = adminRoute('promotions:read', async (_req, { db }) =>
  json(await q.listPromotions(db)),
);

export const POST = adminRoute('promotions:write', async (req, { db, audit }) => {
  const input = z
    .record(z.string(), z.unknown())
    .parse(await (await import('../../../../server/commerce-http')).readJson(req));
  const id = await svc.create(db, input);
  await audit('promotion.created', { type: 'promotion', id });
  return json({ id }, { status: 201 });
});
