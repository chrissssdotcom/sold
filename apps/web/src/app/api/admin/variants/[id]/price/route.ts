import { z } from 'zod';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { body, parseId } from '../../../../../../server/admin/http';
import { getCommerce } from '../../../../../../server/commerce';
import { Money } from '@sold/core';

export const dynamic = 'force-dynamic';
const input = z.strictObject({
  currency: z.string().length(3),
  amount: z.string().regex(/^\d{1,15}$/),
  compareAt: z
    .string()
    .regex(/^\d{1,15}$/)
    .nullable()
    .optional(),
});

export const PUT = adminRoute('catalog:write', async (req, { db, audit }) => {
  const parts = new URL(req.url).pathname.split('/');
  const variantId = parseId(parts[parts.length - 2]);
  const v = await body(req, input);
  const { catalog } = await getCommerce();
  await catalog.setPrice(db, variantId, {
    currency: v.currency,
    amount: Money.of(BigInt(v.amount), v.currency),
    compareAt: v.compareAt ? Money.of(BigInt(v.compareAt), v.currency) : null,
  });
  await audit('price.set', { type: 'variant', id: variantId }, v);
  return json({ ok: true });
});
