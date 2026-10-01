import { z } from 'zod';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { body, parseId } from '../../../../../../server/admin/http';
import { getCommerce } from '../../../../../../server/commerce';

export const dynamic = 'force-dynamic';
const input = z.strictObject({
  onHand: z.number().int().min(0).max(10_000_000),
  allowBackorder: z.boolean().optional(),
});

export const PUT = adminRoute('catalog:write', async (req, { db, audit }) => {
  const parts = new URL(req.url).pathname.split('/');
  const variantId = parseId(parts[parts.length - 2]);
  const v = await body(req, input);
  const { inventory } = await getCommerce();
  await inventory.setOnHand(db, variantId, v.onHand, {
    ...(v.allowBackorder !== undefined ? { allowBackorder: v.allowBackorder } : {}),
  });
  await audit('stock.set', { type: 'variant', id: variantId }, v);
  return json({ ok: true });
});
