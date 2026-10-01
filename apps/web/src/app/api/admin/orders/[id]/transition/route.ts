import { z } from 'zod';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { body, parseId } from '../../../../../../server/admin/http';
import { getCommerce } from '../../../../../../server/commerce';
import { requireCan } from '../../../../../../server/admin-route';

export const dynamic = 'force-dynamic';
const input = z.strictObject({
  to: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  reason: z.string().max(500).optional(),
});

export const POST = adminRoute('orders:write', async (req, { db, audit, user }) => {
  const parts = new URL(req.url).pathname.split('/');
  const id = parseId(parts[parts.length - 2]);
  const v = await body(req, input);
  // Cancelling and fulfilling are separate permissions from editing: a support role may be able to do one, not the other.
  requireCan(user, v.to === 'cancelled' ? 'orders:cancel' : 'orders:fulfil');
  const { orders } = await getCommerce();
  const result = await orders.transition(db, id, v.to, {
    actor: user.email,
    ...(v.reason ? { reason: v.reason } : {}),
  });
  await audit('order.transition', { type: 'order', id }, { to: v.to, from: result.from });
  return json(result);
});
